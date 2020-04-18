import { version } from "package.json"
import yargs from "yargs"
import definition from "./commands/definition"
import deleteCache from "./commands/delete-cache"
import detectify from "./commands/detectify"
import gettingStarted from "./commands/getting-started"
import github from "./commands/github"
import snyk from "./commands/snyk"

declare const BUILD_TIMESTAMP: string

export async function main(): Promise<void> {
  // http://patorjk.com/software/taag/#p=display&f=Slant&t=CALS
  const header = `
      _________    __   _____
     / ____/   |  / /  / ___/
    / /   / /| | / /   \\__ \\
   / /___/ ___ |/ /______/ /
   \\____/_/  |_/_____/____/
     cli ${version}
     built ${BUILD_TIMESTAMP}

https://github.com/capralifecycle/cals-cli/

Usage: cals <command>`

  yargs
    .usage(header)
    .scriptName("cals")
    .locale("en")
    .help("help")
    .command(deleteCache)
    .command(definition)
    .command(detectify)
    .command(github)
    .command(gettingStarted)
    .command(snyk)
    .version(version)
    .demandCommand()
    .option("non-interactive", {
      describe: "Non-interactive mode",
      type: "boolean",
    })
    .option("verbose", {
      describe: "Verbose output",
      type: "boolean",
    })
    .option("validate-cache", {
      describe: "Only read from cache if validated against server",
      type: "boolean",
    })
    .parse()
}

// Definer prosjekt-navn
// Definer ønskede miljøer
// Baselines som skal brukse
// Er bruker logget inn?
// Lag repo og endre commit
// Osv. osv. osv.
