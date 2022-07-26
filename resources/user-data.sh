# Install SSH Agent
echo "Setting up user-data ..."

# Install SSM in case we need to have access to our instance
cd /tmp
sudo yum install -y https://s3.amazonaws.com/ec2-downloads-windows/SSMAgent/latest/linux_amd64/amazon-ssm-agent.rpm
sudo systemctl enable amazon-ssm-agent
sudo systemctl start amazon-ssm-agent

# Create working directory for the vault and take ownership
sudo mkdir /opt/vault
sudo chown -R $USER:$USER /opt/vault

# Install and start Vault server
cd /opt/vault
yum install -y yum-utils
yum-config-manager --add-repo https://rpm.releases.hashicorp.com/AmazonLinux/hashicorp.repo
yum -y install vault
cat > config.hcl << "EOF"
storage "raft" {
  path    = "./vault/data"
  node_id = "node1"
}

listener "tcp" {
  address     = "0.0.0.0:8200"
  tls_disable = "true"
}

api_addr = "http://127.0.0.1:8200"
cluster_addr = "https://127.0.0.1:8201"
ui = true
EOF
mkdir -p ./vault/data
vault server -config=config.hcl