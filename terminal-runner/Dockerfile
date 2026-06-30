# Single pentest-toolbox image for the Security Scan AGENT mode.
#
# The security agent has FULL control over one long-lived container per scan.
# It drives the entire arsenal below via `docker exec` (see
# scanRunner.startAgentToolbox), and the OWASP ZAP daemon also runs INSIDE this
# same container (started as a backgrounded process) so the structured zap_*
# tools + live view keep working. There is no separate ZAP / nuclei / testssl
# container any more — this image is the whole toolbox.
#
# HARDENING — the runtime (scanRunner.startAgentToolbox) launches this container
# with:
#   - NO docker socket mounted (the agent can never reach the host daemon)
#   - an isolated, egress-only network (beeflow-scan-net; no inbound, no access
#     to the API/db/redis or sibling scans)
#   - --security-opt=no-new-privileges
#   - cpu / memory / pids caps (cgroup limits) to bound a runaway tool
#   - CAP_NET_RAW added (single capability, not full root) ONLY when
#     SECURITY_TOOLBOX_NET_RAW is enabled, so nmap -sS / masscan can use raw
#     sockets. Everything else still runs as the unprivileged `scanner` user.
#
# SIZE — this is a Kali-based image with web/recon/vuln metapackages; expect a
# large image (~2-4 GB). BUILD IT ONCE and push to GHCR; the runtime never pulls
# it fresh per scan (resolveToolsImage uses the local tag first). Build:
#   docker build -t beeflow-security-tools:latest server/terminal-runner
# Override the tag at runtime with SECURITY_TOOLS_IMAGE.
FROM kalilinux/kali-rolling

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    PATH="/opt/pd/bin:${PATH}"

# ── Arsenal (apt) ───────────────────────────────────────────────────────────
# Install every package BEST-EFFORT (one at a time) so a single renamed/absent
# package can't abort the whole build (e.g. the recon metapackage is
# `kali-tools-information-gathering`, NOT `kali-tools-recon`). Then HARD-VERIFY
# the critical few — if any of those are missing the build fails fast. ZAP ships
# as `zaproxy` (daemon launched via `zaproxy -daemon ...`).
RUN apt-get update \
    && for p in \
        zaproxy nmap masscan nikto whatweb wafw00f wpscan sqlmap testssl.sh \
        ffuf feroxbuster gobuster nuclei seclists dnsutils whois openssl curl \
        wget jq netcat-openbsd iputils-ping unzip git ruby default-jre-headless \
        python3 python3-pip python3-venv ca-certificates \
        kali-tools-web kali-tools-information-gathering kali-tools-vulnerability kali-tools-fuzzing \
    ; do \
        apt-get install -y --no-install-recommends "$p" || echo "SKIP $p"; \
    done \
    && rm -rf /var/lib/apt/lists/* \
    && for c in zaproxy nmap nuclei sqlmap curl wget python3 unzip; do \
        command -v "$c" >/dev/null || { echo "CRITICAL TOOL MISSING: $c" >&2; exit 1; }; \
    done \
    && ln -sf /usr/bin/testssl /usr/local/bin/testssl.sh

# ── ProjectDiscovery + fuzzing extras (pinned release binaries) ──────────────
# Most of these also ship in the kali metapackages above; this layer pins newer
# builds into /opt/pd/bin (first on PATH). BEST-EFFORT: a 404 on a pinned version
# must NOT fail the whole image build — the apt copies remain as a fallback. No
# inline "#" comments inside the RUN (they break \-continuation parsing).
ARG HTTPX_VERSION=1.6.9
ARG SUBFINDER_VERSION=2.6.6
ARG DNSX_VERSION=1.2.1
ARG KATANA_VERSION=1.1.0
ARG DALFOX_VERSION=2.9.2
RUN set -ux; \
    mkdir -p /opt/pd/bin; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in amd64) goarch=amd64 ;; arm64) goarch=arm64 ;; *) goarch=amd64 ;; esac; \
    fetch_zip() { wget -qO /tmp/pd.zip "$1" && unzip -o -j /tmp/pd.zip "$2" -d /opt/pd/bin || echo "skip $2"; rm -f /tmp/pd.zip; }; \
    fetch_zip "https://github.com/projectdiscovery/httpx/releases/download/v${HTTPX_VERSION}/httpx_${HTTPX_VERSION}_linux_${goarch}.zip" httpx; \
    fetch_zip "https://github.com/projectdiscovery/subfinder/releases/download/v${SUBFINDER_VERSION}/subfinder_${SUBFINDER_VERSION}_linux_${goarch}.zip" subfinder; \
    fetch_zip "https://github.com/projectdiscovery/dnsx/releases/download/v${DNSX_VERSION}/dnsx_${DNSX_VERSION}_linux_${goarch}.zip" dnsx; \
    fetch_zip "https://github.com/projectdiscovery/katana/releases/download/v${KATANA_VERSION}/katana_${KATANA_VERSION}_linux_${goarch}.zip" katana; \
    { wget -qO /tmp/dalfox.tgz "https://github.com/hahwul/dalfox/releases/download/v${DALFOX_VERSION}/dalfox_${DALFOX_VERSION}_linux_${goarch}.tar.gz" && tar -xzf /tmp/dalfox.tgz -C /opt/pd/bin dalfox; } || echo "skip dalfox"; \
    rm -f /tmp/dalfox.tgz; \
    chmod +x /opt/pd/bin/* 2>/dev/null || true

# ── Python helpers ───────────────────────────────────────────────────────────
# A small curated set the agent leans on for ad-hoc scripting. Installed into a
# venv on PATH so we don't fight Debian's externally-managed environment.
RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir requests \
    && ln -sf /opt/venv/bin/python3 /usr/local/bin/pyscan
ENV PATH="/opt/venv/bin:${PATH}"

# ── Non-root user + writable workdir ────────────────────────────────────────
# The agent never needs root. nmap degrades to TCP-connect (-sT) without
# CAP_NET_RAW; SYN scans / masscan light up only when the runtime grants the cap.
RUN (id -u scanner >/dev/null 2>&1 || useradd --create-home --uid 1000 --shell /bin/bash scanner) \
    && mkdir -p /home/scanner/work \
    && chown -R scanner:scanner /home/scanner

# Bake the nuclei templates at build time so the first scan doesn't pay the
# update cost (and so an egress-restricted run still has templates). Owned by
# the scanner user.
USER scanner
RUN nuclei -update-templates -silent || true

# The runtime runs this container as root WITH CapDrop:ALL + CapAdd:NET_RAW (for
# nmap -sS / masscan). Dropping all caps strips CAP_DAC_OVERRIDE/FOWNER, so even
# root obeys file permissions — and useradd made /home/scanner mode 0700. Make
# the home readable/traversable for all and the work dir writable for all so
# capless-root can run ZAP (its -dir/log live under work) and the tools. This is
# a single-use, network-isolated container, so there's no multi-tenant concern.
USER root
RUN chmod -R a+rX /home/scanner && chmod -R a+rwX /home/scanner/work
USER scanner

WORKDIR /home/scanner/work

# Idle forever so the container stays up for `docker exec`. The agent's commands
# (and the backgrounded ZAP daemon) are injected via exec; this process is just
# the keep-alive PID 1.
CMD ["sleep", "infinity"]
