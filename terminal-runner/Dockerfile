# Sandbox image for the Security Scan AGENT mode.
#
# The security agent runs free-form recon/diagnostic commands (curl, openssl,
# nmap, dig, nuclei, ...) and streams their output back over SSE. Those commands
# execute inside a short-lived container built from this image via `docker exec`
# (see scanRunner.startToolsSandbox); the container itself just idles.
#
# HARDENING — the runtime (scanRunner) launches this container with:
#   - NO docker socket mounted (the agent can never reach the host daemon)
#   - an isolated, egress-only network (no inbound, no access to siblings)
#   - --security-opt=no-new-privileges
#   - cpu / memory / pids caps (cgroup limits) to bound a runaway tool
# The image therefore stays deliberately minimal: only the CLI tools the agent
# is allowed to invoke, run as an unprivileged user.
FROM debian:bookworm-slim

# Recon / security CLI toolbelt. --no-install-recommends keeps the image slim
# and the apt lists are removed in the same layer so they don't bloat it.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        curl \
        wget \
        openssl \
        nmap \
        dnsutils \
        jq \
        ca-certificates \
        iputils-ping \
        netcat-openbsd \
        whois \
        git \
        python3 \
    && rm -rf /var/lib/apt/lists/*

# nuclei is NOT available via apt. We intentionally do NOT install it here so a
# missing/blocked download can never fail this build. To bake it in later,
# uncomment the optional layer below (pin the version you want):
#
# ARG NUCLEI_VERSION=3.3.7
# RUN set -eux; \
#     arch="$(dpkg --print-architecture)"; \
#     case "$arch" in amd64) nuclei_arch=amd64 ;; arm64) nuclei_arch=arm64 ;; *) echo "unsupported arch $arch" >&2; exit 1 ;; esac; \
#     wget -qO /tmp/nuclei.zip "https://github.com/projectdiscovery/nuclei/releases/download/v${NUCLEI_VERSION}/nuclei_${NUCLEI_VERSION}_linux_${nuclei_arch}.zip"; \
#     unzip -j /tmp/nuclei.zip nuclei -d /usr/local/bin; \
#     chmod +x /usr/local/bin/nuclei; \
#     rm -f /tmp/nuclei.zip
# (unzip is not installed above — add it to the apt list if you enable this.)

# Run everything as an unprivileged user; the agent never needs root.
RUN useradd --create-home --uid 1000 --shell /usr/sbin/nologin scanner
USER scanner
WORKDIR /home/scanner

# Idle forever so the container stays up for `docker exec`. The agent's commands
# are injected via exec; this process is just the keep-alive PID 1.
CMD ["sleep", "infinity"]
