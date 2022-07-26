const AWS = require('aws-sdk')

const utils = require('./secret-utils')

const sns = new AWS.SNS({})
const sts = new AWS.STS({})

exports.handler = async () => {
  const {
    secretsPrefix,
    secretEncryptionKMSKeyArn,
    failedReplicationTopicArn,
    vaultSecretArn,
    sendFailureNotifications,
    AWS_REGION,
  } = process.env

  const { Account: account } = await sts.getCallerIdentity({}).promise()

  var vault = null
  var hashiCorpSecrets = []
  var awsSMSecrets = []

  try {
    vault = await initialiseVault(vaultSecretArn)

    // List the secrets we have in HashiCorp Vault (HCP Vault)
    const hashiCorpSecretsData = await vault.list(`${secretsPrefix}/metadata`)
    hashiCorpSecrets = hashiCorpSecretsData.data.keys
    console.log('Found the following secrets in the vault: ', hashiCorpSecrets)

    // Get the secrets that we have in AWS Secrets manager
    const awsSMSecretsData = await utils.listSecrets(secretsPrefix)
    awsSMSecrets = awsSMSecretsData.SecretList
    console.log('Found these secrets in Secrets Manager: ', awsSMSecrets)
  } catch (err) {
    // Finish the Lambda function and return an error if we were unable to fetch data from HCP or AWS Secrets Manager
    return {
      status: 'ERROR',
      err,
      message: err.message,
    }
  }

  // Core logic to replicate secrets
  const replicateSecretsParams = {
    hashiCorpSecrets,
    awsSMSecrets,
    secretsPrefix,
    vault,
    secretEncryptionKMSKeyArn
  }
  const { secretsCreated, secretsUpdated, errors } = await replicateSecrets(replicateSecretsParams)

  // If we have any errors in replication
  if (errors.length > 0) {
    if (sendFailureNotifications && failedReplicationTopicArn !== '') {
      // If we've setup email notifications for replication failures, send an email
      await sendSNSEmailNotification(
        failedReplicationTopicArn,
        `Account: ${account}, Region: ${AWS_REGION}. Failed to create/update the following secrets: ${JSON.stringify(
          errors
        )} `
      )
    }
    // Return error if any of the secrets failed to replicate
    return {
      status: 'ERROR',
      message: JSON.stringify(errors),
    }
  }

  // Return 200 OK with nr of secrets created and updated
  returnMessage = `Secrets created: ${secretsCreated.length}, Secrets updated: ${secretsUpdated.length}`
  return {
    status: 'OK',
    results: returnMessage,
  }
}

// Function to initialise HashiCorp Vault API client instance
async function initialiseVault(vaultSecretArn) {
  const { vaultAddress, vaultToken } = await utils.getSecretValue(vaultSecretArn)

  var options = {
    apiVersion: 'v1',
    endpoint: vaultAddress,
    token: vaultToken,
  }

  return require('node-vault')(options)
}

// Function to check HCP secrets, and replicate them to AWS Secrets Manager
async function replicateSecrets(params) {
  const { hashiCorpSecrets, awsSMSecrets, secretsPrefix, vault, secretEncryptionKMSKeyArn } = params

  var secretsCreated = []
  var secretsUpdated = []
  var errors = []

  // Iterate through the secrets in HCP Vault
  for (const secret of hashiCorpSecrets) {
    const secretName = `${secretsPrefix}/${secret}`
    try {
      const existingSecret = awsSMSecrets.find(
        (item) => item.Name === secretName
      )

      // If we don't have a matching secret in AWS Secrets Manager, create a new one.
      if (existingSecret === undefined) {
        console.log('Secret not found - adding new one ...')
        const createSecretParams = {
          secretName,
          secret,
          secretsPrefix,
          vault,
          secretEncryptionKMSKeyArn
        }
        const createdSecret = await utils.createNewSecret(createSecretParams)
        secretsCreated.push(createdSecret)
      } else {
        // Check if we need to update the secret.
        console.log('Secret found - checking if we should update ...')
        updatedSecret = await utils.checkSecret(secretsPrefix, secret, existingSecret)
        if (updatedSecret !== null) {
          secretsUpdated.push(updatedSecret)
        }
      }
    } catch (err) {
      // If we have encountered an error, append it to a list to keep track of the secrets that were not able to be replicated.
      errors.push({ secretName: secretName, error: err.message })
    }
  }

  return { secretsCreated, secretsUpdated, errors }
}

// Function to send a notification email via Amazon SNS to alert of replication failure
function sendSNSEmailNotification(snsTopicArn, message) {
  var params = {
    Message: message,
    TopicArn: snsTopicArn,
  }
  return new Promise((resolve, reject) => {
    sns.publish(params, (err, data) => {
      if (err) return reject(err)
      console.log(data)
      return resolve(JSON.parse(JSON.stringify(data)))
    })
  })
}
