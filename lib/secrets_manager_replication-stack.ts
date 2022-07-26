import { Stack } from 'aws-cdk-lib'
import { Construct } from 'constructs'

import * as secretsManager from 'aws-cdk-lib/aws-secretsmanager'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as s3 from 'aws-cdk-lib/aws-s3'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as kms from 'aws-cdk-lib/aws-kms'
import * as sns from 'aws-cdk-lib/aws-sns'
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions'

import { HcpVaultEc2Resource } from './hcp_vault_ec2_resources'
import { SecretReplicationLambdaFunctionStack } from './secret_replication_lambda_resource'

export interface SecretReplicationStackProps {
  readonly secretsPrefix: string
  readonly hcpvaultInboundIPCidr: string
  readonly notificationEmail: string
  readonly deployHCPVaultOnEC2: boolean
  readonly optionalExternalVaultAddress: string
  readonly lambdaCronSchedule: string
}

export class SecretsManagerReplicationStack extends Stack {
  constructor(
    scope: Construct,
    id: string,
    props: SecretReplicationStackProps
  ) {
    super(scope, id)

    const {
      secretsPrefix,
      notificationEmail,
      hcpvaultInboundIPCidr,
      deployHCPVaultOnEC2,
      optionalExternalVaultAddress,
      lambdaCronSchedule,
    } = props

    // Create a single KMS key used for encryption throughout this project
    const secretEncryptionKMSKey = new kms.Key(this, 'SecretEncryptionKey', {
      enableKeyRotation: true,
      description: 'KMS Key used for AWS Secret Manager encryption',
      alias: `${secretsPrefix}-encryption-key`,
    })

    // Create an encrypted S3 bucket to store server logs and VPC flow logs
    const encryptedBucket = new s3.Bucket(this, 'SecretsSyncEncryptedBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      serverAccessLogsPrefix: 'server_access_logs',
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
    })

    // Validate email address using a regular expression
    function validateEmail(email: string): boolean {
      const emailRegexp =
        /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/
      const validEmail = emailRegexp.test(email)
      if (validEmail === false) {
        throw new TypeError(`${email} not a valid format, and not empty string`)
      }
      return validEmail
    }

    const validEmailProvided =
      notificationEmail !== '' && validateEmail(notificationEmail)

    let failedReplicationTopic

    // If valid email is provided - create Amazon SNS resources to send emails with error notifications
    if (validEmailProvided === true) {
      failedReplicationTopic = new sns.Topic(
        this,
        'FailedSecretReplicationTopic'
      )
      failedReplicationTopic.addSubscription(
        new subscriptions.EmailSubscription(notificationEmail)
      )
    }

    // Create a VPC to deploy EC2 instance running HashiCorp Vault and AWS Lambda function
    const vpc = new ec2.Vpc(this, 'ResourceVpc', {
      natGateways: 1,
      maxAzs: 2,
      cidr: '10.0.0.0/16',
      flowLogs: {
        s3: {
          destination: ec2.FlowLogDestination.toS3(
            encryptedBucket,
            'vpc-flow-logs'
          ),
          trafficType: ec2.FlowLogTrafficType.ALL,
        },
      },
      subnetConfiguration: [
        {
          name: 'private-with-nat',
          subnetType: ec2.SubnetType.PRIVATE_WITH_NAT,
        },
        {
          name: 'public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
      ],
    })

    vpc.node.addDependency(encryptedBucket)

    /*
    * Determine the vault address to add to the vault connection secret.
    * This is used by AWS Lambda to connect to the vault.
    * If we're deploying HCP Vault on EC2, deploy the resources via the HcpVaultEc2Resource Construct.
    * Save the resulting vault address to the vaultAddress variable
    */
    var vaultAddress = optionalExternalVaultAddress
    if (deployHCPVaultOnEC2) {
      const hcpVaultResource = new HcpVaultEc2Resource(this, 'hcpEc2Resource', {
        hcpvaultInboundIPCidr,
        vpc,
      })
      vaultAddress = hcpVaultResource.vaultAddress
    }

    // Create a secret in AWS Secrets Manager to connect to the third-party secrets manager
    const vaultConnectionSecret = new secretsManager.Secret(
      this,
      `VaultConnectionSecret`,
      {
        secretName: `${secretsPrefix}/vault-connection-secret`,
        generateSecretString: {
          secretStringTemplate: JSON.stringify({
            vaultAddress: vaultAddress,
          }),
          excludePunctuation: true,
          includeSpace: false,
          generateStringKey: 'vaultToken',
        },
        encryptionKey: secretEncryptionKMSKey,
      }
    )

    const failedReplicationTopicArn = failedReplicationTopic?.topicArn || ''

    // Create the AWS Lambda function which periodically triggers to replicate secrets from
    // third-party secrets manager to AWS Secrets Manager
    const secretReplicationFunction = new SecretReplicationLambdaFunctionStack(
      this,
      'SecretReplicationLambdaFunction',
      {
        secretsPrefix,
        failedReplicationTopicArn,
        vpc,
        lambdaCronSchedule,
        vaultConnectionSecretArn: vaultConnectionSecret.secretArn,
        encryptionKMSKey: secretEncryptionKMSKey,
        sendFailureNotifications: validEmailProvided,
      }
    )

    // Only Allow the Lambda function access to the Connection Secret. Other secrets may be used by other services
    vaultConnectionSecret.addToResourcePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        principals: [
          new iam.ArnPrincipal(secretReplicationFunction.functionRole.roleArn),
        ],
        actions: ['secretsmanager:GetSecretValue'],
        resources: [vaultConnectionSecret.secretArn],
      })
    )
  }
}
