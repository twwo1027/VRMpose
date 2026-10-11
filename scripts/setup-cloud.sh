#!/usr/bin/env bash
set -euo pipefail
cd /workspace/VRMpose
export npm_config_cache=/workspace/.cache/npm
export XDG_CACHE_HOME=/workspace/.cache
export ELECTRON_BUILDER_CACHE=/workspace/.cache/electron-builder
export electron_config_cache=/workspace/.cache/electron
export NODE_USE_ENV_PROXY=1
mkdir -p "$npm_config_cache" "$XDG_CACHE_HOME" "$ELECTRON_BUILDER_CACHE" "$electron_config_cache"
npm ci --no-audit --no-fund
node node_modules/electron/install.js
if [ ! -x /workspace/.cache/xvfb/usr/bin/Xvfb ]; then
mkdir -p /workspace/.cache/apt/lists/partial /workspace/.cache/apt/archives/partial \
  /workspace/.cache/apt/empty /workspace/.cache/apt/log /workspace/.cache/xvfb/packages
cat > /workspace/.cache/apt/apt.conf <<'APTCONF'
Dir::State::lists "/workspace/.cache/apt/lists";
Dir::State::status "/var/lib/dpkg/status";
Dir::Cache::archives "/workspace/.cache/apt/archives";
Dir::Cache::pkgcache "/workspace/.cache/apt/pkgcache.bin";
Dir::Cache::srcpkgcache "/workspace/.cache/apt/srcpkgcache.bin";
Dir::Log "/workspace/.cache/apt/log";
Dir::Etc::parts "/workspace/.cache/apt/empty";
Dir::Etc::main "/dev/null";
Dir::Etc::sourcelist "/workspace/.cache/apt/sources.list";
Dir::Etc::sourceparts "/workspace/.cache/apt/empty";
APT::Sandbox::User "agent";
Acquire::Languages "none";
Acquire::IndexTargets::deb::DEP-11::DefaultEnabled "false";
Acquire::Retries "0";
APT::Update::Error-Mode "any";
APTCONF
cat > /workspace/.cache/apt/sources.list <<'SOURCES'
deb [signed-by=/usr/share/keyrings/debian-archive-keyring.gpg] https://deb.debian.org/debian trixie main
deb [signed-by=/usr/share/keyrings/debian-archive-keyring.gpg] https://deb.debian.org/debian-security trixie-security main
SOURCES
export APT_CONFIG=/workspace/.cache/apt/apt.conf
apt-get update
cd /workspace/.cache/xvfb/packages
apt-get download xvfb xserver-common
for package_file in ./*.deb; do
  dpkg-deb -x "$package_file" /workspace/.cache/xvfb
done

fi
cd /workspace/VRMpose
npm test
npm run build
