import { Router , NextFunction, Request, Response } from "express";
import { GithubAuthMiddleware, GithubOAuthRouter } from "./github-oauth-router";
import { csrfMiddleware } from "middleware/csrf-middleware";
import { GithubSubscriptionRouter } from "./subscription/github-subscription-router";
import { GithubSetupRouter } from "routes/github/setup/github-setup-router";
import { GithubConfigurationRouter } from "routes/github/configuration/github-configuration-router";
import { GithubManifestRouter } from "~/src/routes/github/manifest/github-manifest-router";
import { GithubServerAppMiddleware } from "middleware/github-server-app-middleware";
import { UUID_REGEX } from "~/src/util/regex";
import { GithubCreateBranchRouter } from "routes/github/create-branch/github-create-branch-router";
import { GithubRepositoryRouter } from "routes/github/repository/github-repository-router";
import { GithubBranchRouter } from "routes/github/branch/github-branch-router";
import { jiraSymmetricJwtMiddleware } from "~/src/middleware/jira-symmetric-jwt-middleware";
import { Errors } from "config/errors";
import { returnOnValidationError } from "routes/api/api-utils";
import { WebhookReceiverPost } from "routes/github/webhook/webhook-receiver-post";
import { header } from "express-validator";

// TODO - Once JWT is passed from Jira for create branch this midddleware is obsolete.
const JiraHostFromQueryParamMiddleware = async (req: Request, res: Response, next: NextFunction) => {
	const jiraHost = req.query?.jiraHost as string;
	if (!jiraHost) {
		req.log.warn(Errors.MISSING_JIRA_HOST);
		res.status(400).send(Errors.MISSING_JIRA_HOST);
		return;
	}
	res.locals.jiraHost = jiraHost;
	next();
};

export const GithubRouter = Router();
const subRouter = Router({ mergeParams: true });
GithubRouter.use(`/:uuid(${UUID_REGEX})?`, subRouter);

// Webhook Route
subRouter.post("/webhooks",
	header(["x-github-event", "x-hub-signature-256", "x-github-delivery"]).exists(),
	returnOnValidationError,
	WebhookReceiverPost);

// Create-branch is seperated above since it currently relies on query param to extract the jirahost
subRouter.use("/create-branch", JiraHostFromQueryParamMiddleware, GithubServerAppMiddleware, GithubAuthMiddleware, csrfMiddleware, GithubCreateBranchRouter);

// OAuth Routes
subRouter.use(GithubOAuthRouter);

subRouter.use(jiraSymmetricJwtMiddleware);
subRouter.use(GithubServerAppMiddleware);

// CSRF Protection Middleware for all following routes
subRouter.use(csrfMiddleware);

subRouter.use("/setup", GithubSetupRouter);

// App Manifest flow routes
subRouter.use("/manifest", GithubManifestRouter);

subRouter.use(GithubAuthMiddleware);

subRouter.use("/configuration", GithubConfigurationRouter);

// TODO: remove optional "s" once we change the frontend to use the proper delete method
subRouter.use("/subscriptions?", GithubSubscriptionRouter);


subRouter.use("/repository", GithubRepositoryRouter);

subRouter.use("/branch", GithubBranchRouter);
