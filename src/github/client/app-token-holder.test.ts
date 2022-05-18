import { AppTokenHolder } from "./app-token-holder";
import { getCloudInstallationId } from "./installation-id";

jest.unmock("lru-cache");

describe("AppTokenHolder", () => {

	beforeEach(() => {
		jest.useFakeTimers("modern");
	});

	afterEach(() => {
		jest.useRealTimers();
	});

	it("Re-generates expired tokens", async () => {
		const appTokenHolder = new AppTokenHolder();
		const jiraHost =  "https://test.atlassian.net";

		jest.setSystemTime(new Date(2021, 10, 25, 10, 0));
		const token1 = appTokenHolder.getAppToken(getCloudInstallationId(4711, jiraHost));
		expect(token1).toBeTruthy();

		// after 5 minutes we still expect the same token because it's still valid
		jest.setSystemTime(new Date(2021, 10, 25, 10, 5));
		const token2 = appTokenHolder.getAppToken(getCloudInstallationId(4711, jiraHost));
		expect(token2).toEqual(token1);

		// after 10 minutes we expect a new token because the old one has expired
		jest.setSystemTime(new Date(2021, 10, 25, 10, 10));
		const token3 = appTokenHolder.getAppToken(getCloudInstallationId(4711, jiraHost));
		expect(token3).not.toEqual(token1);
	});

});
