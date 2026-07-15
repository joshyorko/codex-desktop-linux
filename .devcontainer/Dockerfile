FROM rust:1-bookworm

ARG USERNAME=vscode
ARG USER_UID=1000
ARG USER_GID=$USER_UID
ARG NODE_VERSION=22.22.2
ARG SEVENZIP_VERSION=2600

ENV DEBIAN_FRONTEND=noninteractive
ENV PATH="/usr/local/cargo/bin:${PATH}"

RUN apt-get update -qq \
    && apt-get install -y --no-install-recommends \
        bash \
        ca-certificates \
        curl \
        file \
        g++ \
        gcc \
        git \
        jq \
        libssl-dev \
        make \
        pkg-config \
        python3 \
        ripgrep \
        shellcheck \
        sudo \
        tar \
        unzip \
        xz-utils \
    && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) sevenzip_arch="x64" ;; \
      arm64) sevenzip_arch="arm64" ;; \
      armhf) sevenzip_arch="arm" ;; \
      *) echo "Unsupported 7-Zip architecture: $arch" >&2; exit 1 ;; \
    esac; \
    tmpdir="$(mktemp -d)"; \
    sevenzip_tarball="7z${SEVENZIP_VERSION}-linux-${sevenzip_arch}.tar.xz"; \
    curl -fsSL --retry 3 -o "$tmpdir/$sevenzip_tarball" "https://www.7-zip.org/a/$sevenzip_tarball"; \
    tar -tf "$tmpdir/$sevenzip_tarball" 7zz; \
    tar -C "$tmpdir" -xJf "$tmpdir/$sevenzip_tarball" 7zz; \
    install -m 0755 "$tmpdir/7zz" /usr/local/bin/7zz; \
    rm -rf "$tmpdir"; \
    7zz 2>&1 | grep -m 1 "7-Zip"

RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) node_arch="x64" ;; \
      arm64) node_arch="arm64" ;; \
      armhf) node_arch="armv7l" ;; \
      *) echo "Unsupported Node.js architecture: $arch" >&2; exit 1 ;; \
    esac; \
    node_tarball="node-v${NODE_VERSION}-linux-${node_arch}.tar.xz"; \
    curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/${node_tarball}"; \
    curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"; \
    grep " ${node_tarball}$" SHASUMS256.txt | sha256sum -c -; \
    tar -xJf "${node_tarball}" -C /usr/local --strip-components=1; \
    rm -f "${node_tarball}" SHASUMS256.txt; \
    node --version; \
    npm --version; \
    corepack enable

RUN if ! getent group "$USER_GID" >/dev/null; then groupadd --gid "$USER_GID" "$USERNAME"; fi \
    && if ! getent passwd "$USER_UID" >/dev/null; then useradd --uid "$USER_UID" --gid "$USER_GID" -m "$USERNAME" --shell /bin/bash; fi \
    && echo "$USERNAME ALL=(root) NOPASSWD:ALL" > "/etc/sudoers.d/$USERNAME" \
    && chmod 0440 "/etc/sudoers.d/$USERNAME"

RUN rustup component add rustfmt clippy

RUN printf '%s\n' 'export PATH="/usr/local/cargo/bin:${PATH}"' > /etc/profile.d/rust-cargo-path.sh

USER $USERNAME
WORKDIR /workspaces/codex-desktop-linux
