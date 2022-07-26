#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { SecretsManagerReplicationStack, SecretReplicationStackProps } from '../lib/secrets_manager_replication-stack';

const app = new cdk.App();

// Initialise the Stack, and pass in settings from cdk.json
const settings: SecretReplicationStackProps = app.node.tryGetContext('configuration')
new SecretsManagerReplicationStack(app, 'SecretsManagerReplicationStack', settings);
