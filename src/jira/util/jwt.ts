// Original source code:
// https://bitbucket.org/atlassian/atlassian-connect-express/src/f434e5a9379a41213acf53b9c2689ce5eec55e21/lib/middleware/authentication.js?at=master&fileviewer=file-view-default#authentication.js-227
// TODO: need some typing for jwt
import { decodeAsymmetric, decodeSymmetric, getAlgorithm, getKeyId } from "atlassian-jwt";
import { NextFunction, Request, Response } from "express";
import { envVars } from "config/env";
import { queryAtlassianConnectPublicKey } from "./query-atlassian-connect-public-key";
import { includes, isEmpty } from "lodash";
import { createHash } from "crypto";
import url, { UrlWithParsedQuery } from "url";
import { errorStringFromUnknown } from "~/src/util/error-string-from-unknown";

const JWT_PARAM = "jwt";
const AUTH_HEADER = "authorization"; // the header name appears as lower-case
const BASE_URL = envVars.APP_URL;

/**
 * Atlassian Connect has 2 different types of JWT tokens.
 * Normal tokens has qsh parameter and generated by Jira for backend authentication (like installation webhooks)
 * or web elements like iFrame
 *
 * Context tokens are tokens which are generated by App iframes for the authentication with app backend.
 * They don't require sqh verification and their qsh is set to a fixed `context-qsh` value.
 *
 * When building endpoints we should specify which type of tokens they require
 *
 * See details at: https://community.developer.atlassian.com/t/action-required-atlassian-connect-vulnerability-allows-bypass-of-app-qsh-verification-via-context-jwts/47072
 */
export enum TokenType {
	normal = "normal",
	context = "context"
}


const extractJwtFromRequest = (req: Request): string | undefined => {

	const tokenInQuery = req.query?.[JWT_PARAM];
	const tokenInBody = req.body?.[JWT_PARAM];
	if (tokenInQuery && tokenInBody) {
		req.log.info("JWT token can only appear in either query parameter or request body.");
		return;
	}
	let token = tokenInQuery || tokenInBody;

	const authHeader = req.headers?.[AUTH_HEADER];
	if (authHeader?.startsWith("JWT ")) {
		if (token) {
			const foundIn = tokenInQuery ? "query" : "request body";
			req.log.info(`JWT token found in ${foundIn} and in header: using ${foundIn} value.`);
		} else {
			token = authHeader.substring(4);
		}
	}

	if (!token) {
		token = req.cookies?.[JWT_PARAM];
		if (token) {
			req.log.info("JWT token found in cookies (last resort)");
		}
	}

	// JWT is missing in query and we don't have a valid body.
	if (!token) {
		req.log.info("JWT token is missing in the request");
	}

	return token;
};

export const sendError = (res: Response, code: number, msg: string): void => {
	res.status(code).json({
		message: msg
	});
};

//disable eslint rule as decodeAsymmetric return any
/*eslint-disable @typescript-eslint/no-explicit-any*/
const decodeAsymmetricToken = (token: string, publicKey: string, noVerify: boolean): any => {
	return decodeAsymmetric(
		token,
		publicKey,
		getAlgorithm(token),
		noVerify
	);
};

export const validateQsh = (tokenType: TokenType, qsh: string, request: JWTRequest): boolean => {
	// If token type if of type context, verify automatically if QSH is the correct string
	if (tokenType === TokenType.context) {
		return qsh === "context-qsh";
	}

	/**
	 * TODO: Remove `decodeURIComponent` later
	 * This has been added here as a temporarily until the `qsh` bug is fixed
	 *
	 * Bug: This method `createQueryStringHash` doesn't handle the decoded URI strings passed along the path
	 * For e.g. If we pass a string `http%3A%2F%2Fabc.com`, it doesn't encode it to `http://abc.com`,
	 * but uses the original string, which returns a different `qsh` value.
	 * Because of this reason, if we have any decoded URI in the request path, then it always fails with an error `Wrong qsh`
	 */
	const fixedRequest = {
		...request,
		pathname: request.pathname && decodeURIComponent(request.pathname)
	};
	let expectedHash = createQueryStringHash(fixedRequest, false);
	const signatureHashVerified = qsh === expectedHash;

	if (!signatureHashVerified) {
		// If that didn't verify, it might be a post/put - check the request body too
		expectedHash = createQueryStringHash(fixedRequest, true);
		return qsh === expectedHash;
	}
	return true;
};

export const validateJwtClaims = (verifiedClaims: { exp: number, qsh: string | undefined }, tokenType: TokenType, request: JWTRequest): void => {
	if (!verifiedClaims.qsh) {
		throw new Error("JWT validation Failed, no qsh");
	}

	// 3 second leeway in case of time drift
	if (verifiedClaims.exp && (Date.now() / 1000 - 3) >= verifiedClaims.exp) {
		throw new Error("JWT validation failed, token is expired");
	}

	if (!validateQsh(tokenType, verifiedClaims.qsh, request)) {
		throw new Error("JWT Verification Failed, wrong qsh");
	}
};

const validateSymmetricJwt = (secret: string, request: JWTRequest, tokenType: TokenType, token?: string): void => {
	if (!token) {
		throw new Error("Could not find authentication data on request");
	}

	const algorithm = getAlgorithm(token);

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let unverifiedClaims: any;
	try {
		unverifiedClaims = decodeSymmetric(token, "", algorithm, true); // decode without verification;
	} catch (e: unknown) {
		throw new Error(`Invalid JWT: ${errorStringFromUnknown(e)}`);
	}

	if (!unverifiedClaims.iss) {
		throw new Error("JWT claim did not contain the issuer (iss) claim");
	}

	/* eslint-disable @typescript-eslint/no-explicit-any*/
	let verifiedClaims: any; //due to decodeSymmetric return any
	try {
		verifiedClaims = decodeSymmetric(token, secret, algorithm, false);
	} catch (e: unknown) {
		throw new Error(`Unable to decode JWT token: ${errorStringFromUnknown(e)}`);
	}

	validateJwtClaims(verifiedClaims, tokenType, request);
};

/**
 * Middleware function which verifies JWT token signed by symmetric shared key
 *
 * @param secret Shared key
 * @param tokenType Type of the token normal or context. Context tokens have different qsh verification behaviour
 * @param req Request
 * @param res Response
 * @param next Next function
 */
export const verifySymmetricJwtTokenMiddleware = (secret: string, tokenType: TokenType, req: Request, res: Response, next: NextFunction): void => {
	try {
		const token = extractJwtFromRequest(req);
		validateSymmetricJwt(secret, getJWTRequest(req), tokenType, token);
		req.log.info("JWT Token Verified Successfully!");
		next();
	} catch (error: unknown) {
		req.log.error(error, "Error happened when validating JWT token");
		sendError(res, 401, "Unauthorized");
		return;
	}
};

const ALLOWED_BASE_URLS = [BASE_URL];

const isStagingTenant = (req: Request): boolean => {
	try {
		const hostBaseUrl = req.body?.baseUrl;
		if (hostBaseUrl) {
			const host = new URL(hostBaseUrl).hostname;
			return /\.jira-dev\.com$/.test(host);
		}
	} catch (err: unknown) {
		req.log.error(err, "Error determining Jira instance environment");
	}
	return false;
};

export const validateAsymmetricJwtTokenMiddleware = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
	try {
		const token = extractJwtFromRequest(req);
		await validateAsymmetricJwtToken(getJWTRequest(req), token, isStagingTenant(req));
		req.log.info("JWT Token Verified Successfully!");
		next();
	} catch (err: unknown) {
		req.log.info(err, "Could not validate JWT token");
		res.status(401).json({
			message: "Unauthorized"
		});
	}
};

export const validateAsymmetricJwtToken = async (request: JWTRequest, token?: string, isStaginTenant = false) => {

	if (!token) {
		throw new Error("JWT Verification Failed, no token present");
	}

	const publicKey = await queryAtlassianConnectPublicKey(getKeyId(token), isStaginTenant);
	const unverifiedClaims = decodeAsymmetricToken(token, publicKey, true);

	const issuer = unverifiedClaims.iss;
	if (!issuer) {
		throw new Error("JWT claim did not contain the issuer (iss) claim");
	}

	if (isEmpty(unverifiedClaims.aud) ||
		!unverifiedClaims.aud[0] ||
		!includes(ALLOWED_BASE_URLS, unverifiedClaims.aud[0].replace(/\/$/, ""))) {
		throw new Error("JWT claim did not contain the correct audience (aud) claim");
	}

	const verifiedClaims = decodeAsymmetricToken(token, publicKey, false);

	validateJwtClaims(verifiedClaims, TokenType.normal, request);
};

export interface JWTRequest extends UrlWithParsedQuery {
	method: string;
	body?: any;
}

export const getJWTRequest = (req: Request): JWTRequest => ({
	...url.parse(req.originalUrl || req.url, true),
	method: req.method,
	body: req.body
});

const CANONICAL_QUERY_SEPARATOR = "&";

enum HASH_ALGORITHM {
	HS256 = "sha256",
	HS384 = "sha384",
	HS512 = "sha512",
	RS256 = "RSA-SHA256"
}

export const createQueryStringHash = (req: JWTRequest, checkBodyForParams?: boolean): string => {
	const request = createCanonicalRequest(req, checkBodyForParams);
	const hash = createHash(HASH_ALGORITHM.HS256)
		.update(request)
		.digest("hex");
	return hash;
};

export const createCanonicalRequest = (req: JWTRequest, checkBodyForParams?: boolean): string =>
	canonicalizeMethod(req) +
	CANONICAL_QUERY_SEPARATOR +
	canonicalizeUri(req) +
	CANONICAL_QUERY_SEPARATOR +
	canonicalizeQueryString(req, checkBodyForParams);

const canonicalizeMethod = (req: JWTRequest) => req.method.toUpperCase();

const canonicalizeUri = (req: JWTRequest) => {
	let path = req.pathname;

	if (!path?.length) {
		return "/";
	}

	// If the separator is not URL encoded then the following URLs have the same query-string-hash:
	//   https://djtest9.jira-dev.com/rest/api/2/project&a=b?x=y
	//   https://djtest9.jira-dev.com/rest/api/2/project?a=b&x=y
	path = path.replace(new RegExp(CANONICAL_QUERY_SEPARATOR, "g"), encodeRfc3986(CANONICAL_QUERY_SEPARATOR));

	// Prefix with /
	if (path[0] !== "/") {
		path = "/" + path;
	}

	// Remove trailing /
	if (path.length > 1 && path[path.length - 1] === "/") {
		path = path.substring(0, path.length - 1);
	}

	return path;
};

const canonicalizeQueryString = (req: JWTRequest, checkBodyForParams?: boolean): string => {
	// Change Dict to Object
	let query: Record<string, any> = JSON.parse(JSON.stringify(req.query));
	const method = req.method.toUpperCase();

	// Apache HTTP client (or something) sometimes likes to take the query string and put it into the request body
	// if the method is PUT or POST
	if (checkBodyForParams && isEmpty(query) && (method === "POST" || method === "PUT")) {
		query = Object.fromEntries(req.body);
	}

	if (isEmpty(query)) {
		return "";
	}
	// Remove the 'jwt' query string param
	delete query.jwt;

	return Object.keys(query)
		.sort()
		.reduce((acc: string[], key) => {
			// The __proto__ field can sometimes sneak in depending on what node version is being used.
			// Get rid of it or the qsh calculation will be wrong.
			acc.push(encodeRfc3986(key) + "=" + [].concat(query[key]).sort().map(encodeRfc3986).join(","));
			return acc;
		}, [])
		.join(CANONICAL_QUERY_SEPARATOR);
};

const encodeRfc3986 = (value: string): string =>
	encodeURIComponent(value)
		.replace(/[!'()]/g, escape)
		.replace(/\*/g, "%2A");
