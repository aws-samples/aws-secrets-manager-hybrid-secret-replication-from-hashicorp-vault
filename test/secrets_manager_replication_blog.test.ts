import * as cdk from 'aws-cdk-lib'
import { Template } from 'aws-cdk-lib/assertions'
import * as SecretsManagerReplication from '../lib/secrets_manager_replication-stack'
import { SecretReplicationStackProps } from '../lib/secrets_manager_replication-stack'

const defaultConfig: SecretReplicationStackProps = {
  hcpvaultInboundIPCidr: '0.0.0.0/0',
  notificationEmail: '',
  secretsPrefix: 'hybrid-aws-secrets',
  deployHCPVaultOnEC2: true,
  optionalExternalVaultAddress: '',
  lambdaCronSchedule: 'cron(0,30 * * * ? *)',
}

describe('Default case - HCP on EC2 instance', () => {
  const app = new cdk.App()

  const stack = new SecretsManagerReplication.SecretsManagerReplicationStack(
    app,
    'MyDefaultTestStack',
    defaultConfig
  )

  const template = Template.fromStack(stack)

  test('KMS: Key exists', () => {
    template.hasResource('AWS::KMS::Key', {
      Properties: {
        KeyPolicy: {
          Statement: [
            {
              Action: 'kms:*',
              Effect: 'Allow',
              Principal: {
                AWS: {
                  'Fn::Join': [
                    '',
                    [
                      'arn:',
                      {
                        Ref: 'AWS::Partition',
                      },
                      ':iam::',
                      {
                        Ref: 'AWS::AccountId',
                      },
                      ':root',
                    ],
                  ],
                },
              },
              Resource: '*',
            },
            {
              Action: [
                'kms:Decrypt',
                'kms:Encrypt',
                'kms:ReEncrypt*',
                'kms:GenerateDataKey*',
              ],
              Condition: {
                StringEquals: {
                  'kms:ViaService': {
                    'Fn::Join': [
                      '',
                      [
                        'secretsmanager.',
                        {
                          Ref: 'AWS::Region',
                        },
                        '.amazonaws.com',
                      ],
                    ],
                  },
                },
              },
              Effect: 'Allow',
              Principal: {
                AWS: {
                  'Fn::Join': [
                    '',
                    [
                      'arn:',
                      {
                        Ref: 'AWS::Partition',
                      },
                      ':iam::',
                      {
                        Ref: 'AWS::AccountId',
                      },
                      ':root',
                    ],
                  ],
                },
              },
              Resource: '*',
            },
            {
              Action: ['kms:CreateGrant', 'kms:DescribeKey'],
              Condition: {
                StringEquals: {
                  'kms:ViaService': {
                    'Fn::Join': [
                      '',
                      [
                        'secretsmanager.',
                        {
                          Ref: 'AWS::Region',
                        },
                        '.amazonaws.com',
                      ],
                    ],
                  },
                },
              },
              Effect: 'Allow',
              Principal: {
                AWS: {
                  'Fn::Join': [
                    '',
                    [
                      'arn:',
                      {
                        Ref: 'AWS::Partition',
                      },
                      ':iam::',
                      {
                        Ref: 'AWS::AccountId',
                      },
                      ':root',
                    ],
                  ],
                },
              },
              Resource: '*',
            },
          ],
          Version: '2012-10-17',
        },
        Description: 'KMS Key used for AWS Secret Manager encryption',
        EnableKeyRotation: true,
      },
      UpdateReplacePolicy: 'Retain',
      DeletionPolicy: 'Retain',
    })
  })

  test('Secrets Manager: connection secret exists', () => {
    template.hasResource('AWS::SecretsManager::Secret', {
      Properties: {
        GenerateSecretString: {
          ExcludePunctuation: true,
          GenerateStringKey: 'vaultToken',
          IncludeSpace: false,
          SecretStringTemplate: {
            'Fn::Join': [
              '',
              [
                '{"vaultAddress":"http://',
                {
                  'Fn::GetAtt': [
                    'hcpEc2ResourceVaultInstance58AD810A',
                    'PublicIp',
                  ],
                },
                ':8200"}',
              ],
            ],
          },
        },
        KmsKeyId: {
          'Fn::GetAtt': ['SecretEncryptionKey40C82244', 'Arn'],
        },
        Name: `${defaultConfig.secretsPrefix}/vault-connection-secret`,
      },
      UpdateReplacePolicy: 'Delete',
      DeletionPolicy: 'Delete',
    })
  })

  test('S3: Bucket exists', () => {
    template.hasResource('AWS::S3::Bucket', {
      Properties: {
        BucketEncryption: {
          ServerSideEncryptionConfiguration: [
            {
              ServerSideEncryptionByDefault: {
                SSEAlgorithm: 'AES256',
              },
            },
          ],
        },
        LoggingConfiguration: {
          LogFilePrefix: 'server_access_logs',
        },
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
      },
      UpdateReplacePolicy: 'Retain',
      DeletionPolicy: 'Retain',
    })
  })

  test('Lambda: correct permissions', () => {
    template.hasResource('AWS::IAM::Policy', {
      Properties: {
        PolicyDocument: {
          Statement: [
            {
              Action: [
                'secretsmanager:PutSecretValue',
                'secretsmanager:CreateSecret',
                'secretsmanager:TagResource',
              ],
              Effect: 'Allow',
              Resource: {
                'Fn::Join': [
                  '',
                  [
                    'arn:aws:secretsmanager:',
                    {
                      Ref: 'AWS::Region',
                    },
                    ':',
                    {
                      Ref: 'AWS::AccountId',
                    },
                    `:secret:${defaultConfig.secretsPrefix}/*`,
                  ],
                ],
              },
            },
            {
              Action: [
                'secretsmanager:PutSecretValue',
                'secretsmanager:CreateSecret',
                'secretsmanager:TagResource',
              ],
              Effect: 'Deny',
              NotResource: {
                'Fn::Join': [
                  '',
                  [
                    'arn:aws:secretsmanager:',
                    {
                      Ref: 'AWS::Region',
                    },
                    ':',
                    {
                      Ref: 'AWS::AccountId',
                    },
                    `:secret:${defaultConfig.secretsPrefix}/*`,
                  ],
                ],
              },
            },
            {
              Action: ['kms:Decrypt', 'kms:GenerateDataKey'],
              Effect: 'Allow',
              Resource: {
                'Fn::GetAtt': ['SecretEncryptionKey40C82244', 'Arn'],
              },
            },
            {
              Action: 'kms:*',
              Effect: 'Deny',
              NotResource: {
                'Fn::GetAtt': ['SecretEncryptionKey40C82244', 'Arn'],
              },
            },
            {
              Action: 'secretsmanager:ListSecrets',
              Effect: 'Allow',
              Resource: '*',
              Sid: 'PolicyToAllowListAction',
            },
          ],
          Version: '2012-10-17',
        },
        PolicyName:
          'SecretReplicationLambdaFunctionlambdasecretpermissionsABF66954',
        Roles: [
          {
            Ref: 'SecretReplicationLambdaFunctionSecretReplicationFunctionServiceRole92E9C7DF',
          },
        ],
      },
    })
  })

  test('Lambda: Test Cron Expression trigger', () => {
    template.hasResource('AWS::Events::Rule', {
      Properties: {
        ScheduleExpression: 'cron(0,30 * * * ? *)',
        State: 'ENABLED',
        Targets: [
          {
            Arn: {
              'Fn::GetAtt': [
                'SecretReplicationLambdaFunctionSecretReplicationFunction6441B286',
                'Arn',
              ],
            },
            Id: 'Target0',
          },
        ],
      },
    })
  })

  test('EC2: EC2 infrastructure exists', () => {
    template.hasResource('AWS::EC2::Instance', {
      Properties: {
        AvailabilityZone: {
          'Fn::Select': [
            0,
            {
              'Fn::GetAZs': '',
            },
          ],
        },
        IamInstanceProfile: {
          Ref: 'hcpEc2ResourceVaultInstanceInstanceProfileF0D4C39F',
        },
        ImageId: {
          Ref: 'SsmParameterValueawsserviceamiamazonlinuxlatestamznamihvmx8664gp2C96584B6F00A464EAD1953AFF4B05118Parameter',
        },
        InstanceType: 't2.micro',
        SecurityGroupIds: [
          {
            'Fn::GetAtt': [
              'hcpEc2ResourceVaultSecurityGroup88E3A2F4',
              'GroupId',
            ],
          },
        ],
        SubnetId: {
          Ref: 'ResourceVpcpublicSubnet1Subnet5BE98F21',
        },
        Tags: [
          {
            Key: 'Name',
            Value: 'MyDefaultTestStack/hcpEc2Resource/VaultInstance',
          },
        ],
        // "UserData": { "Fn::Base64": String(String(userDataScript)) }
      },
    })
  })

  test('EC2: Inbound CIDR test default', () => {
    template.hasResource('AWS::EC2::SecurityGroup', {
      Properties: {
        GroupDescription:
          'MyDefaultTestStack/hcpEc2Resource/VaultSecurityGroup',
        GroupName: 'vaultSecurityGroup',
        SecurityGroupEgress: [
          {
            CidrIp: '0.0.0.0/0',
            Description: 'Allow all outbound traffic by default',
            IpProtocol: '-1',
          },
        ],
        SecurityGroupIngress: [
          {
            CidrIp: '0.0.0.0/0',
            Description: 'Allow incoming traffic over port 8200',
            FromPort: 8200,
            IpProtocol: 'tcp',
            ToPort: 8200,
          },
        ],
        VpcId: {
          Ref: 'ResourceVpc0663FB92',
        },
      },
    })
  })

  test('SNS: No SNS resources created', () => {
    expect(template.findResources('AWS::SNS::Topic', {})).toStrictEqual({})
  })
})

describe('Input edge cases', () => {
  test('Test invalid cron expression throws error', () => {
    const app = new cdk.App()
    const INVALID_CRON_EXPRESSION = 'cron(1 s * x)'

    var props_copy = { ...defaultConfig }
    props_copy.lambdaCronSchedule = INVALID_CRON_EXPRESSION
    const props: SecretReplicationStackProps = props_copy

    try {
      new SecretsManagerReplication.SecretsManagerReplicationStack(
        app,
        'MyDefaultTestStack',
        props
      )
      expect(true).toBe(false) // Fail test if no exception thrown
    } catch (e) {
      expect(e).toStrictEqual(TypeError('Invalid Cron String'))
    }
  })

  test('Test inbound IP restriction', () => {
    const app = new cdk.App()
    const SPECIFIC_MOCK_IP = '1.1.1.1/32'

    var props_copy = { ...defaultConfig }
    props_copy.hcpvaultInboundIPCidr = SPECIFIC_MOCK_IP
    const props: SecretReplicationStackProps = props_copy

    const stack = new SecretsManagerReplication.SecretsManagerReplicationStack(
      app,
      'MyDefaultTestStack',
      props
    )

    const template = Template.fromStack(stack)

    template.hasResource('AWS::EC2::SecurityGroup', {
      Properties: {
        GroupDescription:
          'MyDefaultTestStack/hcpEc2Resource/VaultSecurityGroup',
        GroupName: 'vaultSecurityGroup',
        SecurityGroupEgress: [
          {
            CidrIp: '0.0.0.0/0',
            Description: 'Allow all outbound traffic by default',
            IpProtocol: '-1',
          },
        ],
        SecurityGroupIngress: [
          {
            CidrIp: SPECIFIC_MOCK_IP, // LOCK DOWN INBOUND TRAFFIC TO THIS IP
            Description: 'Allow incoming traffic over port 8200',
            FromPort: 8200,
            IpProtocol: 'tcp',
            ToPort: 8200,
          },
        ],
        VpcId: {
          Ref: 'ResourceVpc0663FB92',
        },
      },
    })
  })
})

describe('Deployment with external secret store', () => {
  const app = new cdk.App()
  const EXTERNAL_VAULT_IP = '1.1.1.1/32'

  var props_copy = { ...defaultConfig }
  props_copy.optionalExternalVaultAddress = EXTERNAL_VAULT_IP
  props_copy.deployHCPVaultOnEC2 = false
  const props: SecretReplicationStackProps = props_copy

  const stack = new SecretsManagerReplication.SecretsManagerReplicationStack(
    app,
    'MyDefaultTestStack',
    props
  )

  const template = Template.fromStack(stack)

  test('No EC2 resources created', () => {
    expect(template.findResources('AWS::EC2::Instance')).toStrictEqual({})
  })

  test('Vault connection secret contains provided ip address', () => {
    template.hasResource('AWS::SecretsManager::Secret', {
      Properties: {
        GenerateSecretString: {
          ExcludePunctuation: true,
          GenerateStringKey: 'vaultToken',
          IncludeSpace: false,
          SecretStringTemplate: `{"vaultAddress":"${EXTERNAL_VAULT_IP}"}`,
        },
        KmsKeyId: {
          'Fn::GetAtt': ['SecretEncryptionKey40C82244', 'Arn'],
        },
        Name: 'hybrid-aws-secrets/vault-connection-secret',
      },
      UpdateReplacePolicy: 'Delete',
      DeletionPolicy: 'Delete',
    })
  })

  /*
   * If an empty "" ip address is provided, we still want to create the secret so that users
   * can edit the secret manually after deployment and insert the IP address if they wish.
   */
  test('Vault connection secret with empty ip address', () => {
    const app = new cdk.App()
    const EXTERNAL_VAULT_IP = ''

    var props_copy = { ...defaultConfig }
    props_copy.optionalExternalVaultAddress = EXTERNAL_VAULT_IP
    props_copy.deployHCPVaultOnEC2 = false
    const props: SecretReplicationStackProps = props_copy

    const stack = new SecretsManagerReplication.SecretsManagerReplicationStack(
      app,
      'MyDefaultTestStack',
      props
    )

    const template = Template.fromStack(stack)
    template.hasResource('AWS::SecretsManager::Secret', {
      Properties: {
        GenerateSecretString: {
          ExcludePunctuation: true,
          GenerateStringKey: 'vaultToken',
          IncludeSpace: false,
          SecretStringTemplate: `{"vaultAddress":"${EXTERNAL_VAULT_IP}"}`,
        },
        KmsKeyId: {
          'Fn::GetAtt': ['SecretEncryptionKey40C82244', 'Arn'],
        },
        Name: 'hybrid-aws-secrets/vault-connection-secret',
      },
      UpdateReplacePolicy: 'Delete',
      DeletionPolicy: 'Delete',
    })
  })
})

describe('Replication failure notification tests', () => {
  test('SNS Resources created with valid email address', () => {
    const app = new cdk.App()
    const MOCK_NOTIFICATION_EMAIL = 'notification@mock.com'

    var props_copy = { ...defaultConfig }

    props_copy.notificationEmail = MOCK_NOTIFICATION_EMAIL
    const props: SecretReplicationStackProps = props_copy

    const stack = new SecretsManagerReplication.SecretsManagerReplicationStack(
      app,
      'MyDefaultTestStack',
      props
    )

    const template = Template.fromStack(stack)

    template.hasResource('AWS::SNS::Topic', {})
  })

  test('Error thrown if no valid email address', () => {
    const app = new cdk.App()
    const MOCK_NOTIFICATION_EMAIL = 'someInvalidEmail@.@.com'

    var props_copy = { ...defaultConfig }

    props_copy.notificationEmail = MOCK_NOTIFICATION_EMAIL
    const props: SecretReplicationStackProps = props_copy

    try {
      new SecretsManagerReplication.SecretsManagerReplicationStack(
        app,
        'MyDefaultTestStack',
        props
      )
      expect(true).toBe(false) // Fail test if no error thrown
    } catch (e) {
      expect(e).toStrictEqual(
        TypeError(
          'someInvalidEmail@.@.com not a valid format, and not empty string'
        )
      )
    }
  })
})
