import { basename } from 'path'

import { expectEnv } from './lib/env'
import { getLogger } from './lib/logger'
import { MongoDBConnectionManager } from './client/mongodb'

import { PostgreSQLConnectionManager } from './client/postgres'
import { MongoDBPersistence } from './dao/mongodb'
import { PostgreSQLPersistence } from './dao/postgres'
import {
  DatabaseMigrationService,
  IDatabaseConnectionManager,
  IPersistenceFacade
} from './service'
import { IRevision, loadDirectory } from './revision'

// eg. your-app-name
const REVISIONS_NAMESPACE = expectEnv('REVISIONS_NAMESPACE')

// eg. /Users/eddiecorrigall/repos/my-project/dist/src/revisions
const REVISIONS_DIRECTORY = expectEnv('REVISIONS_DIRECTORY')

// eg. postgresql, mongodb, etc.
const REVISIONS_CLIENT = expectEnv('REVISIONS_CLIENT')

const logger = getLogger('CLI')
let db: IDatabaseConnectionManager<unknown>
let dao: IPersistenceFacade<any>

switch (REVISIONS_CLIENT) {
  case 'mongodb': {
    const uri = expectEnv('MONGODB_URI')
    const connection = MongoDBConnectionManager.createConnection(uri)
    db = new MongoDBConnectionManager(connection, { logger })
    dao = new MongoDBPersistence({ logger })
  } break
  case 'postgresql': {
    const pool = PostgreSQLConnectionManager.createPool()
    db = new PostgreSQLConnectionManager(pool, { logger })
    dao = new PostgreSQLPersistence({ logger })
  } break
  default: {
    console.error(`ERROR: Unknown client [${REVISIONS_CLIENT}]`)
    process.exit(1)
  }
}

process.on('exit', () => {
  void db.shutdown()
})

const migrationService = new DatabaseMigrationService({ dao, logger })

const newRevision = async (description: string): Promise<void> => {
  console.log('New revision...')
  const revisionFile = await migrationService.newRevision(
    REVISIONS_DIRECTORY,
    description
  )
  console.log(`file: ${revisionFile}`)
}

const fetchCurrentRevision = async (): Promise<void> => {
  console.log('Fetching current revision...')
  let currentRevision: IRevision | undefined
  await db.transaction(async (client: unknown) => {
    await dao.initialize(client)
    currentRevision = await migrationService.fetchCurrentRevision(
      client,
      REVISIONS_NAMESPACE
    )
  })
  if (currentRevision === undefined) {
    console.log('version: (base)')
  } else {
    const displayPreviousVersion = currentRevision.previousVersion ?? '(base)'
    const displayVersion = currentRevision.version
    const displayFile = basename(currentRevision.file)
    console.log(`previous: ${displayPreviousVersion}`)
    console.log(`version:  ${displayVersion}`)
    console.log(`file:     ${displayFile}`)
  }
}

const listRevisions = async (): Promise<void> => {
  console.log('Listing revisions...')
  let currentRevision: IRevision | undefined
  await db.transaction(async (client: unknown) => {
    await dao.initialize(client)
    currentRevision = await migrationService.fetchCurrentRevision(
      client,
      REVISIONS_NAMESPACE
    )
  })
  const revisionModules = loadDirectory(REVISIONS_DIRECTORY)
  const currentRevisionModuleIndex = revisionModules.findIndex(
    (revision) => revision.version === currentRevision?.version
  )
  for (let index = 0; index < revisionModules.length; index++) {
    const revisionModule = revisionModules[index]
    const displayPreviousVersion = revisionModule.previousVersion ?? '(base)'
    let displayVersion = revisionModule.version
    if (index === currentRevisionModuleIndex) {
      displayVersion += ' (current)'
    } else if (index < currentRevisionModuleIndex) {
      displayVersion += ' (applied)'
    } else {
      displayVersion += ' (pending)'
    }
    const displayFile = basename(revisionModule.file)
    console.log('---')
    console.log(`index:    ${index}`)
    console.log(`previous: ${displayPreviousVersion}`)
    console.log(`version:  ${displayVersion}`)
    console.log(`file:     ${displayFile}`)
  }
}

const upgrade = async (): Promise<void> => {
  console.log('Upgrading database...')
  await db.transaction(async (client: unknown) => {
    await dao.initialize(client)
    // Lock all concurrent writes, but allow concurrent reads
    await dao.acquireExclusiveLock(client)
    // Apply all pending revisions
    const {
      initialRevision,
      pendingRevisionModules
    } = await migrationService.upgrade(
      client, REVISIONS_NAMESPACE, REVISIONS_DIRECTORY
    )
    const finalRevisionModule = pendingRevisionModules[
      pendingRevisionModules.length - 1
    ]
    if (pendingRevisionModules.length === 0) {
      console.log('nothing to upgrade')
    } else if (initialRevision === undefined) {
      console.log(`version: (base) -> ${finalRevisionModule.version}`)
      console.log(`file:    (base) -> ${basename(finalRevisionModule.file)}`)
    } else {
      console.log(
        'version: ' +
        initialRevision.version +
        ' -> ' +
        finalRevisionModule.version
      )
      console.log(
        'file:    ' +
        basename(initialRevision.file) +
        ' -> ' +
        basename(finalRevisionModule.file)
      )
    }
    // Unlock resource
    await dao.releaseExclusiveLock(client)
  })
  await listRevisions()
}

const downgrade = async (): Promise<void> => {
  console.log('Downgrading database...')
  await db.transaction(async (client: unknown) => {
    await dao.initialize(client)
    // Lock all concurrent writes, but allow concurrent reads
    await dao.acquireExclusiveLock(client)
    // Revert current revision
    const {
      finalRevision,
      pendingRevisionModules
    } = await migrationService.downgrade(
      client, REVISIONS_NAMESPACE, REVISIONS_DIRECTORY)

    const initialRevisionModule = pendingRevisionModules[0]

    if (pendingRevisionModules.length === 0) {
      console.log('nothing to downgrade')
    } else if (finalRevision === undefined) {
      console.log(`version: ${initialRevisionModule.version} -> (base)`)
      console.log(`file:    ${basename(initialRevisionModule.file)} -> (base)`)
    } else {
      console.log(
        'version: ' +
        initialRevisionModule.version +
        ' -> ' +
        finalRevision.version
      )
      console.log(
        'file:    ' +
        basename(initialRevisionModule.file) +
        ' -> ' +
        basename(finalRevision.file)
      )
    }
    // Unlock resource
    await dao.releaseExclusiveLock(client)
  })
  await listRevisions()
}

const printUsage = async (): Promise<void> => {
  console.log('Usage: migrate [new|version|list|up|down|help]')
  console.log('Environment variables:')
  console.log(
    '  REVISIONS_NAMESPACE ' +
    '- namespace for managing more than one version'
  )
  console.log(
    '  REVISIONS_DIRECTORY ' +
    '- path to revisions directory containing revisions files'
  )
  console.log(
    '  REVISIONS_CLIENT    ' +
    '- database client type (eg. postgresql, mongodb, etc)'
  )
}

const args = process.argv.slice(2)

if (args.length === 0) {
  void printUsage().then(() => {
    process.exit(1)
  })
}

const onSuccess = (): void => {
  process.exit(0)
}

const onFailure = (reason?: string): void => {
  if (reason !== undefined) {
    console.error(reason)
  }
  process.exit(1)
}

const command = args[0]?.toLowerCase()

switch (command) {
  case 'new': {
    const description = process.argv[3]
    if (description === undefined) {
      void printUsage().then(() => {
        onFailure('missing description')
      })
    } else {
      newRevision(description).then(onSuccess, onFailure)
    }
    break
  }
  case 'version': fetchCurrentRevision().then(onSuccess, onFailure); break
  case 'list': listRevisions().then(onSuccess, onFailure); break
  case 'up': upgrade().then(onSuccess, onFailure); break
  case 'down': downgrade().then(onSuccess, onFailure); break
  case 'help': printUsage().then(onSuccess, onFailure); break
  default: {
    onFailure(`unknown command [${command}]`)
  }
}
