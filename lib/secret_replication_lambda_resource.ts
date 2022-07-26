import { Duration, Stack } from 'aws-cdk-lib'
import { Construct } from 'constructs'

import * as logs from 'aws-cdk-lib/aws-logs'
import * as events from 'aws-cdk-lib/aws-events'
import * as targets from 'aws-cdk-lib/aws-events-targets'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as kms from 'aws-cdk-lib/aws-kms'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as ec2 from 'aws-cdk-lib/aws-ec2'

// Interface with settings required for this construct from cdk.json file
export interface SecretReplicationLambdaFunctionProps {
  readonly vaultConnectionSecretArn: string
  readonly secretsPrefix: string
  readonly failedReplicationTopicArn: string
  readonly encryptionKMSKey: kms.IKey
  readonly vpc: ec2.IVpc
  readonly sendFailureNotifications: boolean
  readonly lambdaCronSchedule: string
}

export class SecretReplicationLambdaFunctionStack extends Construct {
  public readonly functionRole: iam.IRole

  constructor(
    scope: Construct,
    id: string,
    props: SecretReplicationLambdaFunctionProps
  ) {
    super(scope, id)
    const { region, account } = Stack.of(this)
    const {
      vpc,
      vaultConnectionSecretArn,
      secretsPrefix,
      failedReplicationTopicArn,
      encryptionKMSKey,
      sendFailureNotifications,
      lambdaCronSchedule,
    } = props

    // Create security group for the Lambda function
    const fnSg = new ec2.SecurityGroup(this, 'SyncLambdaSecGroup', {
      securityGroupName: `SyncLambdaSecGroup`,
      vpc,
      allowAllOutbound: true,
    })

    // Create AWS Lambda function for replication
    const secretsReplicationFunction = new lambda.DockerImageFunction(
      this,
      'SecretReplicationFunction',
      {
        memorySize: 128,
        code: lambda.DockerImageCode.fromImageAsset(
          `${__dirname}/../resources/lambda-function`,
          {}
        ),
        vpc,
        securityGroups: [fnSg],
        timeout: Duration.minutes(2),
        logRetention: logs.RetentionDays.FIVE_MONTHS,
        allowAllOutbound: true,
        environment: {
          vaultSecretArn: vaultConnectionSecretArn,
          secretsPrefix: secretsPrefix,
          secretEncryptionKMSKeyArn: encryptionKMSKey.keyArn,
          failedReplicationTopicArn: failedReplicationTopicArn,
          sendFailureNotifications: String(sendFailureNotifications),
        },
        environmentEncryption: encryptionKMSKey,
      }
    )

    // Helper function to check if cron expression is valid
    function isValidCron(expression: string): boolean {
      var cronregex = new RegExp(
        "^(rate\\(((1 (hour|minute|day))|(\\d+ (hours|minutes|days)))\\))|(cron\\(\\s*($|#|\\w+\\s*=|(\\?|\\*|(?:[0-5]?\\d)(?:(?:-|\\/|\\,)(?:[0-5]?\\d))?(?:,(?:[0-5]?\\d)(?:(?:-|\\/|\\,)(?:[0-5]?\\d))?)*)\\s+(\\?|\\*|(?:[0-5]?\\d)(?:(?:-|\\/|\\,)(?:[0-5]?\\d))?(?:,(?:[0-5]?\\d)(?:(?:-|\\/|\\,)(?:[0-5]?\\d))?)*)\\s+(\\?|\\*|(?:[01]?\\d|2[0-3])(?:(?:-|\\/|\\,)(?:[01]?\\d|2[0-3]))?(?:,(?:[01]?\\d|2[0-3])(?:(?:-|\\/|\\,)(?:[01]?\\d|2[0-3]))?)*)\\s+(\\?|\\*|(?:0?[1-9]|[12]\\d|3[01])(?:(?:-|\\/|\\,)(?:0?[1-9]|[12]\\d|3[01]))?(?:,(?:0?[1-9]|[12]\\d|3[01])(?:(?:-|\\/|\\,)(?:0?[1-9]|[12]\\d|3[01]))?)*)\\s+(\\?|\\*|(?:[1-9]|1[012])(?:(?:-|\\/|\\,)(?:[1-9]|1[012]))?(?:L|W|#)?(?:[1-9]|1[012])?(?:,(?:[1-9]|1[012])(?:(?:-|\\/|\\,)(?:[1-9]|1[012]))?(?:L|W|#)?(?:[1-9]|1[012])?)*|\\?|\\*|(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(?:(?:-)(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC))?(?:,(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(?:(?:-)(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC))?)*)\\s+(\\?|\\*|(?:[0-6])(?:(?:-|\\/|\\,|#)(?:[0-6]))?(?:L)?(?:,(?:[0-6])(?:(?:-|\\/|\\,|#)(?:[0-6]))?(?:L)?)*|\\?|\\*|(?:MON|TUE|WED|THU|FRI|SAT|SUN)(?:(?:-)(?:MON|TUE|WED|THU|FRI|SAT|SUN))?(?:,(?:MON|TUE|WED|THU|FRI|SAT|SUN)(?:(?:-)(?:MON|TUE|WED|THU|FRI|SAT|SUN))?)*)(|\\s)+(\\?|\\*|(?:|\\d{4})(?:(?:-|\\/|\\,)(?:|\\d{4}))?(?:,(?:|\\d{4})(?:(?:-|\\/|\\,)(?:|\\d{4}))?)*))\\))$"
      )
      // Source for regex: https://gist.github.com/andrew-templeton/aca7fc6c166e9b8a46aa
      return cronregex.test(expression)
    }

    // Check if provided cron is valid, otherwise, throw error.
    if (isValidCron(lambdaCronSchedule) === false) {
      throw new TypeError('Invalid Cron String')
    }

    // Schedule execution of Lambda function per the specific cron expression. Default: on minute 0 and minute 30 every hour.
    const lambdaCron = new events.Rule(this, 'syncScheduler', {
      schedule: events.Schedule.expression(lambdaCronSchedule),
    })
    lambdaCron.addTarget(new targets.LambdaFunction(secretsReplicationFunction))

    const secretManagerActions = [
      'secretsmanager:PutSecretValue',
      'secretsmanager:CreateSecret',
      'secretsmanager:TagResource',
    ]

    // START OF PERMISSION SETTINGS FOR LAMBDA EXECUTION ROLE
    // For more details on permissions, see README.md
    const secretsManagerPermissions = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: secretManagerActions,
      resources: [
        `arn:aws:secretsmanager:${region}:${account}:secret:${secretsPrefix}/*`,
      ],
    })

    const secretsManagerListPermissions = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['secretsmanager:ListSecrets'],
      resources: ['*'],
      sid: 'PolicyToAllowListAction',
    })

    // Deny any secrets manager action, which is not on a resource matching our replication prefix
    const denyStatement = new iam.PolicyStatement({
      effect: iam.Effect.DENY,
      actions: secretManagerActions,
      notResources: [
        `arn:aws:secretsmanager:${region}:${account}:secret:${secretsPrefix}/*`,
      ],
    })

    const secretsManagerKMSPermissions = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
      resources: [encryptionKMSKey.keyArn],
    })

    // Deny any KMS action on a resource which is not our KMS encryption key
    const denyStatementKMS = new iam.PolicyStatement({
      effect: iam.Effect.DENY,
      actions: ['kms:*'],
      notResources: [encryptionKMSKey.keyArn],
    })

    var permissionStatements = [
      secretsManagerPermissions,
      denyStatement,
      secretsManagerKMSPermissions,
      denyStatementKMS,
      secretsManagerListPermissions,
    ]

    // Opt: if we want to send notification on replication failure, give Lambda SNS permissions
    if (sendFailureNotifications) {
      const snsPermissions = new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['sns:Publish'],
        resources: [failedReplicationTopicArn],
      })

      const snsDenyPermissions = new iam.PolicyStatement({
        effect: iam.Effect.DENY,
        actions: ['sns:*'],
        notResources: [failedReplicationTopicArn],
      })

      permissionStatements = permissionStatements.concat([
        snsPermissions,
        snsDenyPermissions,
      ])
    }

    if (secretsReplicationFunction.role === undefined) {
      throw Error("Cannot access function's role")
    }

    secretsReplicationFunction.role.attachInlinePolicy(
      new iam.Policy(this, 'lambda-secret-permissions', {
        statements: permissionStatements,
      })
    )
    // END OF LAMBDA EXECUTION ROLE PERMISSIONS

    this.functionRole = secretsReplicationFunction.role
  }
}
