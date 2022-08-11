import { Subscription } from "models/subscription";
import { getJiraClient } from "~/src/jira/client/jira-client";
import { Request, Response } from "express";

/**
 * Handle the when a user deletes an entry in the UI
 *
 */
export const JiraDelete = async (req: Request, res: Response): Promise<void> => {
	const { jiraHost, gitHubAppId } = res.locals;
	// TODO: The params `installationId` needs to be replaced by `subscriptionId`
	const installationId = Number(req.params.installationId) || Number(req.body.installationId);

	if (!jiraHost) {
		req.log.error("Missing Jira Host");
		res.status(401).send("Missing jiraHost");
		return;
	}

	if (!installationId) {
		req.log.error("Missing Github Installation ID");
		res.status(401).send("Missing Github Installation ID");
		return;
	}

	req.log.info({ installationId }, "Received Jira DELETE request");

	const subscription = await Subscription.getSingleInstallation(
		jiraHost,
		installationId,
		gitHubAppId
	);

	const gitHubInstallationId = subscription?.gitHubInstallationId || installationId;

	if (!subscription) {
		res.status(404).send("Cannot find Subscription");
		return;
	}

	const jiraClient = await getJiraClient(jiraHost, installationId, req.log);
	await jiraClient.devinfo.installation.delete(gitHubInstallationId);
	await subscription.destroy();

	res.sendStatus(204);
};
