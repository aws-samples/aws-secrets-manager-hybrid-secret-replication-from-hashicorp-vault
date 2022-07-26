import { Construct } from 'constructs'
import { CfnOutput } from 'aws-cdk-lib'
import { readFileSync } from 'fs'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as iam from 'aws-cdk-lib/aws-iam'

export interface HcpVaultEc2Props {
  readonly vpc: ec2.IVpc
  readonly hcpvaultInboundIPCidr: string
}

// Construct to represent EC2 resources required to deploy Open Source HashiCorp Vault EC2
export class HcpVaultEc2Resource extends Construct {
  public readonly vaultAddress: string

  constructor(scope: Construct, id: string, props: HcpVaultEc2Props) {
    super(scope, id)
    const { vpc, hcpvaultInboundIPCidr } = props

    // Create security group for EC2 instance and allow outbound traffic
    const ec2Sg = new ec2.SecurityGroup(this, 'VaultSecurityGroup', {
      securityGroupName: 'vaultSecurityGroup',
      vpc,
      allowAllOutbound: true,
    })

    // Add ingress rule to allow traffic from a specific IP Cidr range specified in cdk.json (0.0.0.0/0 by default)
    ec2Sg.addIngressRule(
      ec2.Peer.ipv4(hcpvaultInboundIPCidr),
      ec2.Port.tcp(8200),
      `Allow incoming traffic over port 8200`
    )


    // Specify instance role for EC2 instance
    const instanceRole = new iam.Role(this, 'MyRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
    })

    // Attach SSM permissions to allow SSM access for debugging purposes
    instanceRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')
    )

    // Create EC2 instance, T2.Micro by default, and place it in our public subnet
    const vaultInstance = new ec2.Instance(this, 'VaultInstance', {
      vpc,
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T2,
        ec2.InstanceSize.MICRO
      ),
      machineImage: new ec2.AmazonLinuxImage(),
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroup: ec2Sg,
      role: instanceRole,
    })

    // Required to make sure we delete the instance before the VPC when running cdk destroy
    vaultInstance.node.addDependency(vpc)

    // Read our user-data script from file
    const userDataScript = readFileSync(
      `${__dirname}/../resources/user-data.sh`,
      'utf8'
    )

    // Add our user-data script to the instance
    vaultInstance.addUserData(userDataScript)

    // Set a public attribute of the construct to include the public IP.
    // This is required to create a connection secret for our endpoint in Secrets Manager later in the script
    this.vaultAddress = `http://${vaultInstance.instancePublicIp}:8200`

    // Output two variables in console
    new CfnOutput(this, 'PublicIpOutput', {
      value: vaultInstance.instancePublicIp,
    })

    new CfnOutput(this, 'VaultUIAddress', { value: `${this.vaultAddress}/ui` })
  }
}
