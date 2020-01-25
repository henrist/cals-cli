import { GitHubService } from "../../../github/service"
import { Reporter } from "../../reporter"

export async function reportRateLimit(
  reporter: Reporter,
  github: GitHubService,
  block: () => Promise<void>,
) {
  reporter.info(
    `Rate limit: ${(await github.octokit.rateLimit.get()).data.rate.remaining}`,
  )

  await block()

  reporter.info(
    `Rate limit: ${(await github.octokit.rateLimit.get()).data.rate.remaining}`,
  )
}
