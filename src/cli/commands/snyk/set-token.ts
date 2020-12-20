import read from "read"
import { CommandModule } from "yargs"
import { SnykTokenCliProvider } from "../../../snyk/token"
import { Reporter } from "../../reporter"
import { createReporter } from "../../util"

async function setToken({
  reporter,
  token,
  tokenProvider,
}: {
  reporter: Reporter
  token: string | undefined
  tokenProvider: SnykTokenCliProvider
}) {
  if (token === undefined) {
    reporter.info("Need API token to talk to Snyk")
    reporter.info("See https://app.snyk.io/account")

    token = await new Promise<string>((resolve, reject) => {
      read(
        {
          prompt: "Enter new Snyk API token: ",
          silent: true,
        },
        (err, answer) => {
          if (err) {
            reject(err)
          }
          resolve(answer)
        },
      )
    })
  }

  await tokenProvider.setToken(token)
  reporter.info("Token saved")
}

const command: CommandModule = {
  command: "set-token",
  describe: "Set Snyk token for API calls",
  builder: (yargs) =>
    yargs.positional("token", {
      describe: "Token. If not provided it will be requested as input",
    }),
  handler: async (argv) =>
    setToken({
      reporter: createReporter(argv),
      token: argv.token as string | undefined,
      tokenProvider: new SnykTokenCliProvider(),
    }),
}

export default command
