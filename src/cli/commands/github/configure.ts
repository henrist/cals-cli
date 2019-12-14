import { OrgsGetResponse, TeamsListResponseItem } from '@octokit/rest'
import pLimit, { Limit } from 'p-limit'
import read from 'read'
import { CommandModule } from 'yargs'
import { Reporter } from '../../../cli/reporter'
import { getDefinition, getGitHubOrgs } from '../../../definition/definition'
import { Definition } from '../../../definition/types'
import {
  createChangeSetItemsForMembers,
  createChangeSetItemsForProjects,
  createChangeSetItemsForTeams,
} from '../../../github/changeset/changeset'
import { executeChangeSet } from '../../../github/changeset/execute'
import { ChangeSetItem } from '../../../github/changeset/types'
import { createGitHubService, GitHubService } from '../../../github/service'
import { createCacheProvider, createConfig, createReporter } from '../../util'
import { reportRateLimit } from './util'

function createOrgGetter(github: GitHubService) {
  const orgs: {
    [name: string]: {
      org: OrgsGetResponse
      teams: TeamsListResponseItem[]
    }
  } = {}

  // Use a semaphore for each orgName to restrict multiple
  // concurrent requests of the same org.
  const semaphores: { [orgName: string]: Limit } = {}
  function getSemaphore(orgName: string) {
    if (!(orgName in semaphores)) {
      semaphores[orgName] = pLimit(1)
    }
    return semaphores[orgName]
  }

  return async function(orgName: string) {
    return await getSemaphore(orgName)(async () => {
      if (!(orgName in orgs)) {
        const org = await github.getOrg(orgName)
        orgs[orgName] = {
          org,
          teams: await github.getTeamList(org),
        }
      }
      return orgs[orgName]
    })
  }
}

async function process(
  reporter: Reporter,
  github: GitHubService,
  definition: Definition,
  getOrg: ReturnType<typeof createOrgGetter>,
  execute: boolean,
  limitToOrg: string | null,
) {
  let changes: ChangeSetItem[] = []

  for (const orgName of getGitHubOrgs(definition)) {
    if (limitToOrg !== null && limitToOrg !== orgName) {
      continue
    }

    const org = (await getOrg(orgName)).org

    changes = [
      ...changes,
      ...(await createChangeSetItemsForMembers(github, definition, org)),
    ]

    changes = [
      ...changes,
      ...(await createChangeSetItemsForTeams(github, definition, org)),
    ]
  }

  changes = [
    ...changes,
    ...(await createChangeSetItemsForProjects(github, definition, limitToOrg)),
  ]

  if (changes.length === 0) {
    reporter.info(`No actions to be performed`)
  } else {
    reporter.info(`To be performed:`)
    for (const change of changes) {
      reporter.info('  - ' + JSON.stringify(change))
    }
  }

  if (execute && changes.length > 0) {
    const cont = await new Promise<string>((resolve, reject) => {
      read(
        {
          prompt: 'Confirm you want to execute the changes [y/N]: ',
          timeout: 60000,
        },
        (err, answer) => {
          if (err) {
            reject(err)
          }
          resolve(answer)
        },
      )
    })

    if (cont === 'y' || cont === 'Y') {
      reporter.info('Executing changes')
      await executeChangeSet(github, changes, reporter)
    } else {
      reporter.info('Skipping')
    }
  }

  reporter.info(`Number of GitHub requests: ${github.requestCount}`)
}

const command: CommandModule = {
  command: 'configure',
  describe: 'Configure CALS GitHub resources',
  builder: yargs =>
    yargs
      .options('execute', {
        describe: 'Execute the detected changes',
        type: 'boolean',
      })
      .options('all-orgs', {
        describe: 'Ignore organization filter',
        type: 'boolean',
      }),
  handler: async argv => {
    const org = !!argv['all-orgs'] ? null : (argv['org'] as string)

    const reporter = createReporter(argv)
    const config = createConfig()
    const github = await createGitHubService(
      config,
      createCacheProvider(config, argv),
    )
    const definition = getDefinition(config)

    await reportRateLimit(reporter, github, async () => {
      const orgGetter = createOrgGetter(github)

      await process(
        reporter,
        github,
        definition,
        orgGetter,
        !!argv['execute'],
        org,
      )
    })
  },
}

export default command
