const AWS = require('aws-sdk')

const secrets = new AWS.SecretsManager({})

const TAGKEY = 'version'

// Calls the HCP vault to read the secret, and creates a new secret in AWS Secrets Manager
exports.createNewSecret = async(params) => {
  const { secretName, secret, secretsPrefix, vault, secretEncryptionKMSKeyArn } = params

  console.log('Secret not found - adding new one ...')
  const vaultResponse = await vault.read(`${secretsPrefix}/data/${secret}`)
  const secretVersion = String(vaultResponse.data.metadata.version)

  const secretCreated = await createSecret(
    secretName,
    vaultResponse.data.data,
    secretVersion,
    secretEncryptionKMSKeyArn
  )
  console.log('Secret created')
  return secretCreated
}

/**
 * Checks a secret value by pulling it from HCP Vault, checking the version, and if the versions don't match
 * update the secret in AWS Secrets Manager to match HCP Vault.
 */
exports.checkSecret = async (secretsPrefix, secret, existingSecret) => {
  const secretMetaData = await vault.read(`${secretsPrefix}/metadata/${secret}`)
  const currentVersion = String(secretMetaData.data.current_version)
  const currentAWSSMVersion = String(
    existingSecret.Tags.find((item) => item.Key === 'version').Value
  )
  console.log('Current version in vault: ', currentVersion)
  console.log('Version in Secrets Manager: ', currentAWSSMVersion)
  if (currentVersion !== currentAWSSMVersion) {
    console.log('Version mismatch - updating secret ...')
    const secretData = await vault.read(`${secretsPrefix}/data/${secret}`)
    const updatedSecret = await updateSecret(existingSecret.ARN, secretData.data.data)
    await tagResource(existingSecret.ARN, currentVersion)
    console.log(`Secret updated - new version: ${currentVersion}`)
    return updatedSecret
  }
  return null
}

// Gets a secrets from AWS Secrets Manager by secret id
exports.getSecretValue = (secretId) => {
  return new Promise((resolve, reject) => {
    secrets.getSecretValue({ SecretId: secretId }, (err, data) => {
      if (err) return reject(err)
      return resolve(JSON.parse(data.SecretString))
    })
  })
}

// Lists the secrets currently in AWS Secrets Manager, filtering by the secret prefix used for replication
exports.listSecrets = (secretsPrefix) => {
  var params = {
    Filters: [{ Key: 'name', Values: [`${secretsPrefix}/`] }],
  }

  return new Promise((resolve, reject) => {
    secrets.listSecrets(params, (err, data) => {
      if (err) return reject(err)
      return resolve(JSON.parse(JSON.stringify(data)))
    })
  })
}

// Creates a new AWS Secrets Manager Secret
function createSecret(secretName, secretValue, version, kmsKeyArn) {
  var params = {
    Name: secretName,
    SecretString: JSON.stringify(secretValue),
    Tags: [{ Key: TAGKEY, Value: version }],
    KmsKeyId: kmsKeyArn,
  }

  return new Promise((resolve, reject) => {
    secrets.createSecret(params, (err, data) => {
      if (err) {
        return reject(err)
      }
      console.log(data)
      return resolve(JSON.parse(JSON.stringify(data)))
    })
  })
}

// Tags the AWS Secrets Manager secret with a version tag
function tagResource(secretId, tagValue) {
  var params = {
    SecretId: secretId,
    Tags: [{ Key: TAGKEY, Value: tagValue }],
  }

  return new Promise((resolve, reject) => {
    secrets.tagResource(params, (err, data) => {
      if (err) return reject(err)
      return resolve(JSON.parse(JSON.stringify(data)))
    })
  })
}

// Update AWS Secrets Manager secret
function updateSecret(secretId, secretValue) {
  var params = {
    SecretId: secretId,
    SecretString: JSON.stringify(secretValue),
  }

  return new Promise((resolve, reject) => {
    secrets.putSecretValue(params, (err, data) => {
      if (err) {
        return reject(err)
      }
      return resolve(JSON.parse(JSON.stringify(data)))
    })
  })
}
