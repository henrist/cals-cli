import {
  OrgsGetResponse,
  ReposGetResponse,
  ReposListTeamsResponseItem,
  TeamsListResponseItem,
} from '@octokit/rest'
import fs from 'fs'
import yaml from 'js-yaml'
import pAll from 'p-all'
import pMap from 'p-map'
import { CommandModule } from 'yargs'
import { Config } from '../../../config'
import {
  getDefinition,
  getRawDefinition,
  getRepoId,
  getRepos,
} from '../../../definition/definition'
import {
  Definition,
  DefinitionRepo,
  Project,
  RepoTeam,
  Team,
  User,
} from '../../../definition/types'
import { createGitHubService, GitHubService } from '../../../github/service'
import { Permission, Repo, TeamMemberOrInvited } from '../../../github/types'
import { createSnykService, SnykService } from '../../../snyk/service'
import { SnykGitHubRepo } from '../../../snyk/types'
import { getGitHubRepo } from '../../../snyk/util'
import { Reporter } from '../../reporter'
import { createCacheProvider, createConfig, createReporter } from '../../util'
import { reportRateLimit } from '../github/util'

interface DetailedProject {
  name: string
  repos: {
    [org: string]: {
      basic: Repo
      repository: ReposGetResponse
      teams: ReposListTeamsResponseItem[]
    }[]
  }
}

async function getReposFromGitHub(
  github: GitHubService,
  orgs: OrgsGetResponse[],
): Promise<DetailedProject['repos'][0]> {
  const queries = []

  for (const org of orgs) {
    const repos = await github.getRepoList({ owner: org.login })
    for (const repo of repos) {
      queries.push(async () => {
        const detailedRepo = await github.getRepository(
          repo.owner.login,
          repo.name,
        )
        if (detailedRepo === undefined) {
          throw Error(`Repo not found: ${repo.owner.login}/${repo.name}`)
        }

        return {
          basic: repo,
          repository: detailedRepo,
          teams: await github.getRepositoryTeamsList(detailedRepo),
        }
      })
    }
  }

  return pAll(queries)
}

async function getTeams(github: GitHubService, orgs: OrgsGetResponse[]) {
  const result: {
    [org: string]: {
      team: TeamsListResponseItem
      users: TeamMemberOrInvited[]
    }[]
  } = {}

  for (const org of orgs) {
    const queries = []
    const teams = await github.getTeamList(org)
    for (const team of teams) {
      queries.push(async () => {
        return {
          team,
          users: await github.getTeamMemberListIncludingInvited(team),
        }
      })
    }
    result[org.login] = await pAll(queries)
  }

  return result
}

function getCommonTeams(ownerRepos: DetailedProject['repos'][0]) {
  return ownerRepos.length === 0
    ? []
    : ownerRepos[0].teams.filter(team =>
        ownerRepos.every(repo =>
          repo.teams.some(
            otherTeam =>
              otherTeam.name === team.name &&
              otherTeam.permission === team.permission,
          ),
        ),
      )
}

function getSpecificTeams(
  teams: ReposListTeamsResponseItem[],
  commonTeams: ReposListTeamsResponseItem[],
) {
  return teams.filter(team => !commonTeams.some(it => it.name === team.name))
}

function getFormattedTeams(teams: ReposListTeamsResponseItem[]) {
  return teams.length === 0
    ? undefined
    : teams
        .map<RepoTeam>(it => ({
          name: it.name,
          permission: it.permission as Permission,
        }))
        .sort((a, b) => a.name.localeCompare(b.name))
}

async function getOrgs(github: GitHubService, orgs: string[]) {
  return pMap(orgs, it => github.getOrg(it))
}

function removeDuplicates<T, R>(items: T[], selector: (item: T) => R): T[] {
  const ids: R[] = []
  const result: T[] = []
  for (const item of items) {
    const id = selector(item)
    if (!ids.includes(id)) {
      result.push(item)
      ids.push(id)
    }
  }
  return result
}

async function getMembers(github: GitHubService, orgs: OrgsGetResponse[]) {
  return removeDuplicates(
    (await pMap(orgs, org =>
      github.getOrgMembersListIncludingInvited(org.login),
    ))
      .flat()
      .map(it => it.login),
    it => it,
  )
}

function buildTeamsList(
  list: Record<
    string,
    {
      team: TeamsListResponseItem
      users: TeamMemberOrInvited[]
    }[]
  >,
) {
  return Object.entries(list)
    .map(([org, teams]) => ({
      organization: org,
      teams: teams.map<Team>(team => ({
        name: team.team.name,
        members: team.users
          .map(it => it.login)
          .sort((a, b) => a.localeCompare(b)),
      })),
    }))
    .sort((a, b) => a.organization.localeCompare(b.organization))
}

async function dumpSetup(
  config: Config,
  reporter: Reporter,
  github: GitHubService,
  snyk: SnykService,
  outfile: string,
) {
  reporter.info('Fetching data. This might take some time')
  const orgs = await getOrgs(github, ['capralifecycle', 'capraconsulting'])
  const definition = getDefinition(config)
  const snykRepos = (await snyk.getProjects())
    .map(it => getGitHubRepo(it))
    .filter((it): it is SnykGitHubRepo => it !== undefined)
    .map(it => getRepoId(it.owner, it.name))
  const projectMap = getRepos(definition).reduce<Record<string, string>>(
    (acc, cur) => ({
      ...acc,
      [cur.id]: cur.project.name,
    }),
    {},
  )
  const repos = await getReposFromGitHub(github, orgs)

  const projects = Object.values(
    repos.reduce<{
      [project: string]: {
        name: string
        repos: {
          [owner: string]: typeof repos | undefined
        }
      }
    }>((acc, cur) => {
      const org = cur.repository.owner.login
      const projectName =
        projectMap[getRepoId(org, cur.repository.name)] || 'Unknown'
      const project = acc[projectName] || {
        name: projectName,
        repos: [],
      }

      return {
        ...acc,
        [projectName]: {
          ...project,
          repos: {
            ...project.repos,
            [org]: [...(project.repos[org] || []), cur],
          },
        },
      }
    }, {}),
  )
    .map<Project>(project => ({
      name: project.name,
      github: Object.entries(project.repos)
        .map(([org, list]) => {
          const commonTeams = getCommonTeams(list!)
          return {
            organization: org,
            teams: getFormattedTeams(commonTeams),
            repos: list!
              .map<DefinitionRepo>(repo => ({
                name: repo.basic.name,
                archived: repo.repository.archived ? true : undefined,
                issues: repo.repository.has_issues ? undefined : false,
                wiki: repo.repository.has_wiki ? undefined : false,
                teams: getFormattedTeams(
                  getSpecificTeams(repo.teams, commonTeams),
                ),
                snyk: snykRepos.includes(
                  getRepoId(repo.basic.owner.login, repo.basic.name),
                )
                  ? true
                  : undefined,
                public: repo.repository.private ? undefined : true,
              }))
              .sort((a, b) => a.name.localeCompare(b.name)),
          }
        })
        .sort((a, b) => a.organization.localeCompare(b.organization)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))

  const teams = await getTeams(github, orgs)
  const members = await getMembers(github, orgs)

  const generatedDefinition: Definition = {
    snyk: definition.snyk,
    github: {
      users: members
        .map<User>(
          memberLogin =>
            definition.github.users.find(
              user => user.login === memberLogin,
            ) || {
              type: 'external',
              login: memberLogin,
              // TODO: Fetch name from GitHub?
              name: '*Unknown*',
            },
        )
        .sort((a, b) => a.login.localeCompare(b.login)),
      teams: buildTeamsList(teams),
    },
    projects,
  }

  // TODO: An earlier version we had preserved comments by using yawn-yaml
  //  package. However it often produced invalid yaml, so we have removed
  //  it. We might want to revisit it to preserve comments.

  const doc = yaml.safeLoad(getRawDefinition(config))
  doc.snyk = generatedDefinition.snyk
  doc.projects = generatedDefinition.projects
  doc.github = generatedDefinition.github

  // Convert to/from plain JSON so that undefined elements are removed.
  fs.writeFileSync(outfile, yaml.safeDump(JSON.parse(JSON.stringify(doc))))
  reporter.info(`Saved to ${outfile}`)
}

const command: CommandModule = {
  command: 'dump-setup',
  describe:
    'Dump active setup as YAML. Will be formated same as the definition file.',
  builder: yargs =>
    yargs
      .positional('outfile', {
        type: 'string',
      })
      .demandOption('outfile'),
  handler: async argv => {
    const reporter = createReporter()
    const config = createConfig()
    const github = await createGitHubService(
      config,
      createCacheProvider(config),
    )
    const snyk = await createSnykService(config)
    await reportRateLimit(reporter, github, () =>
      dumpSetup(config, reporter, github, snyk, argv.outfile as string),
    )
  },
}

export default command
