#!/usr/bin/env bash

echo -n "Please provide the IP address of the Vault (_excluding_ port and /ui path) > "
read VaultIp

### STEP 1 ###
# Initialise the Raft storage with 1 root key split, and 1 secret_threshold

if [ ! -f init/vault_init_output.json ]; then
  echo "No init details found, trying to initialize raft storage for vault ..."
  curl \
      --request POST \
      --data '{"secret_shares": 1, "secret_threshold": 1}' \
      http://${VaultIp}:8200/v1/sys/init -o init/vault_init_output.json -s
fi

UnsealKey=$(jq -r .keys[0] init/vault_init_output.json)
RootToken=$(jq -r .root_token init/vault_init_output.json)

if [ -z $UnsealKey ]; then
  echo "Cannot find unseal information, previous step must've failed. Check init/vault_init_output.json file for details"
  exit 1
fi

### STEP 2 ###
# Unseal the vault using the key from previous step

curl \
    --request POST \
    --data "{\"key\": \"${UnsealKey}\"}" \
    http://${VaultIp}:8200/v1/sys/unseal -o init/vault_unseal_output.json -s

VaultSealed=$(jq -r .sealed init/vault_unseal_output.json)

if ! [ $VaultSealed == 'false' ]; then
  echo "Vault not unsealed, previous step must've failed. Check init/vault_unseal_output.json file for details or delete the contents of init/ if you've started again from scratch."
  exit 1
fi

### STEP 3 ###
# Enable KV Secrets Engine using the prefix defined in cdk.json

Prefix=$(jq -r .context.configuration.secretsPrefix cdk.json)

curl \
    --header "X-Vault-Token: ${RootToken}" \
    --request POST \
    --data '{"type": "kv", "options": {"version": "2"}, "description": "Sample KV Secrets Engine to test AWS Secrets replication"}' \
    http://${VaultIp}:8200/v1/sys/mounts/${Prefix} -s

### STEP 4 ###
# Create a Super Secret Engine to showcase that that isn't replicated
curl \
    --header "X-Vault-Token: ${RootToken}" \
    --request POST \
    --data '{"type": "kv", "options": {"version": "2"}, "description": "Super Secret Engine that should not be replicated"}' \
    http://${VaultIp}:8200/v1/sys/mounts/super-secret-engine -s


### STEP 5 ###
# Create Secrets in both engines
echo -n "Would you like to generate sample secrets? (y/n) "
read GenerateSecrets
if ! [ "$GenerateSecrets" == "" ] && ([ "$GenerateSecrets" == "Y" ] || [ "$GenerateSecrets" == "y" ]); then
    echo "Creating secrets ... "
    curl \
        --header "X-Vault-Token: ${RootToken}" \
        --request POST \
        --data '{"data": {"foo": "bar", "secrets": "manager"}}' \
        http://${VaultIp}:8200/v1/${Prefix}/data/first-secret-for-replication -s > /dev/null

    curl \
        --header "X-Vault-Token: ${RootToken}" \
        --request POST \
        --data '{"data": {"foo2": "bar2", "secrets2": "manager2"}}' \
        http://${VaultIp}:8200/v1/${Prefix}/data/second-secret-for-replication -s > /dev/null

    curl \
        --header "X-Vault-Token: ${RootToken}" \
        --request POST \
        --data '{"data": {"super": "secret"}}' \
        http://${VaultIp}:8200/v1/super-secret-engine/data/super-secret -s > /dev/null
fi



### STEP 6 ###
# Create a new api token with Read only capabilities that the AWS Lambda function can use

echo "{
  \"policy\": \"path \\\"${Prefix}/*\\\" { capabilities = [\\\"read\\\", \\\"list\\\"] }\"
}" > init/replication-policy-payload.json

curl --request PUT \
     --header "X-Vault-Token: ${RootToken}" \
     --data @init/replication-policy-payload.json \
    http://${VaultIp}:8200/v1/sys/policy/aws-replication-read-only


curl \
    --header "X-Vault-Token: ${RootToken}" \
    --request POST \
    --data '{"policies":["aws-replication-read-only"]}' \
    http://${VaultIp}:8200/v1/auth/token/create -s | jq '.auth' > init/aws-lambda-token-output.json

LambdaToken=$(jq -r .client_token init/aws-lambda-token-output.json)


### STEP 7 ###
# Print outputs
echo "Root token for vault:"
echo ${RootToken}
echo ""
echo "Read-only token for hybrid secrets in vault:"
echo ${LambdaToken}
