import debug from 'debug'
import { EMAIL_TYPE, parseTextToNumber } from '@web3-storage/db'

console.log('packages/cron/src/jobs/storage.js loaded')
const log = debug('storage:checkStorageUsed')

const supportEmail = 'support@web3.storage'

const USER_BY_USED_STORAGE_QUERY = `
  SELECT * FROM users_by_storage_used($1, $2, $3, $4)
`

const MIN_MAX_USER_ID = `
 SELECT min(id)::TEXT as min, max(id)::TEXT as max from public.user
`

const USER_BY_EMAIL_QUERY = `
  SELECT id AS _id , email, name FROM public.user WHERE email=$1
`

const userByStorageRowToUser = (row) => {
  const storageQuota = parseTextToNumber(row.storage_quota)
  const storageUsed = parseTextToNumber(row.storage_used)
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    storageQuota,
    storageUsed,
    percentStorageUsed: Math.floor((storageUsed / storageQuota) * 100)
  }
}

const STORAGE_QUOTA_EMAILS = [
  {
    emailType: EMAIL_TYPE.User100PercentStorage,
    fromPercent: 100,
    // 1 day approx, with flexibility for cron irregularity
    secondsSinceLastSent: 60 * 60 * 23
  },
  {
    emailType: EMAIL_TYPE.User90PercentStorage,
    fromPercent: 90,
    toPercent: 100,
    // 1 day approx, with flexibility for cron irregularity
    secondsSinceLastSent: 60 * 60 * 23
  },
  {
    emailType: EMAIL_TYPE.User85PercentStorage,
    fromPercent: 85,
    toPercent: 90,
    // 1 week approx, with flexibility for cron irregularity
    secondsSinceLastSent: 60 * 60 * 24 * 7 - (60 * 60)
  },
  {
    emailType: EMAIL_TYPE.User80PercentStorage,
    fromPercent: 80,
    toPercent: 85,
    // 1 week approx, with flexibility for cron irregularity
    secondsSinceLastSent: 60 * 60 * 24 * 7 - (60 * 60)
  },
  {
    emailType: EMAIL_TYPE.User75PercentStorage,
    fromPercent: 75,
    toPercent: 80,
    // 1 week approx, with flexibility for cron irregularity
    secondsSinceLastSent: 60 * 60 * 24 * 7 - (60 * 60)
  }
]

/**
 * Get users with storage quota usage in percentage range and email them as
 * appropriate when approaching their storage quota limit.
 * @param {{
 *  roPg: import('pg').Client
 *  emailService: import('../lib/email/service').EmailService
 *  userBatchSize?: number
 * }} config
 */
export async function checkStorageUsed ({ roPg, emailService, userBatchSize = 1000 }) {
  console.log('checkStorageUsed has been called.')
  if (!log.enabled) {
    console.log('ℹ️ Enable logging by setting DEBUG=storage:checkStorageUsed')
  }

  /** @type {{ rows: Array.<{min: string, max: string}> }} */
  const { rows: minMax } = await roPg.query(MIN_MAX_USER_ID)

  const min = BigInt(minMax[0].min)
  const max = BigInt(minMax[0].max)
  const batchSize = BigInt(userBatchSize)

  console.log('🗄 Checking users storage quotas.')
  log('🗄 Checking users storage quotas')

  for (const email of STORAGE_QUOTA_EMAILS) {
    console.log(`doing email type: ${email.emailType}`)
    const usersOverQuota = []
    let start = min
    let isLastBatch = false

    while (!isLastBatch) {
      let to = start + batchSize
      console.log(`doing a batch, from ${start} to ${to}`)

      if (to > max) {
        // set `to` for the last batch to be null so that we take instances that might have been created
        // since the initial query.
        to = null
        isLastBatch = true
      }
      const { rows: results } = await roPg.query(USER_BY_USED_STORAGE_QUERY, [
        email.fromPercent,
        email.toPercent,
        start,
        to
      ])

      console.log(`got ${results.length} results`)

      const users = results
        .map(userByStorageRowToUser)

      console.log(`got ${users.length} users`)
      if (email.emailType === EMAIL_TYPE.User100PercentStorage && users.length > 0) {
        usersOverQuota.push(...users)
      }

      for (const user of users) {
        const to = {
          _id: user.id,
          email: user.email,
          name: user.name
        }

        const emailSent = await emailService.sendEmail(to, email.emailType, {
          ...(email.secondsSinceLastSent && { secondsSinceLastSent: email.secondsSinceLastSent })
        })

        if (emailSent) {
          if (email.emailType === EMAIL_TYPE.User100PercentStorage) {
            log(`📧 Sent a quota exceeded email to ${user.name}: ${user.percentStorageUsed}% of quota used`)
            console.log(`📧 Sent a quota exceeded email to ${user.name}: ${user.percentStorageUsed}% of quota used`)
          } else {
            log(`📧 Sent an email to ${user.name}: ${user.percentStorageUsed}% of quota used`)
            console.log(`📧 Sent an email to ${user.name}: ${user.percentStorageUsed}% of quota used`)
          }
        }
      }
      start = to
    }

    console.log(`Got ${usersOverQuota.length} users over quota`)
    if (usersOverQuota.length > 0) {
      const { rows: results } = await roPg.query(USER_BY_EMAIL_QUERY, [supportEmail])

      if (!results.length) {
        throw new Error(`${supportEmail} does not exists`)
      }

      const toAdmin = results[0]

      const emailSent = await emailService.sendEmail(toAdmin, EMAIL_TYPE.AdminStorageExceeded, {
        secondsSinceLastSent: email.secondsSinceLastSent,
        templateVars: { users: usersOverQuota }
      })

      if (emailSent) {
        log('📧 Sent a list of users exceeding their quotas to admin')
        console.log('📧 Sent a list of users exceeding their quotas to admin')
      }
    }
  }

  log('✅ Done')
  console.log('✅ Done')
}
