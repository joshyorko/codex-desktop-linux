FROM rust:1-bookworm

ARG USERNAME=vscode
ARG USER_UID=1000
ARG USER_GID=$USER_UID
ARG NODE_VERSION=22.22.2

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
        p7zip-full \
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

RUN set -eux; \
    if command -v 7zz >/dev/null 2>&1 && 7zz 2>&1 | grep -qm 1 "7-Zip"; then \
        echo "7zz already available at $(command -v 7zz)"; \
    else \
        arch="$(dpkg --print-architecture)"; \
        case "$arch" in \
            amd64) sevenzip_arch="x64" ;; \
            arm64) sevenzip_arch="arm64" ;; \
            *) echo "Unsupported architecture for 7zz bootstrap: $arch" >&2; exit 1 ;; \
        esac; \
        tmpdir="$(mktemp -d)"; \
        trap 'rm -rf "$tmpdir"' EXIT; \
        found=0; \
        for candidate in 2601 2600 2500 2409; do \
            candidate_tag="${candidate:0:2}.${candidate:2:2}"; \
            candidate_url="https://github.com/ip7z/7zip/releases/download/${candidate_tag}/7z${candidate}-linux-${sevenzip_arch}.tar.xz"; \
            if curl -fsL --retry 2 --retry-delay 2 -o "$tmpdir/7z.tar.xz" "$candidate_url" \
                && tar -tf "$tmpdir/7z.tar.xz" 7zz >/dev/null 2>&1; then \
                found=1; \
                echo "Installing 7zz ${candidate} from ${candidate_url}"; \
                tar -C "$tmpdir" -xf "$tmpdir/7z.tar.xz" 7zz; \
                install -m 755 "$tmpdir/7zz" /usr/local/bin/7zz; \
                break; \
            fi; \
            rm -f "$tmpdir/7z.tar.xz"; \
        done; \
        if [ "$found" -ne 1 ]; then \
            echo "Could not find a known-good 7zz tarball for architecture '$arch'." >&2; \
            exit 1; \
        fi; \
    fi; \
    /usr/local/bin/7zz --help >/dev/null

RUN if ! getent group "$USER_GID" >/dev/null; then groupadd --gid "$USER_GID" "$USERNAME"; fi \
    && if ! getent passwd "$USER_UID" >/dev/null; then useradd --uid "$USER_UID" --gid "$USER_GID" -m "$USERNAME" --shell /bin/bash; fi \
    && echo "$USERNAME ALL=(root) NOPASSWD:ALL" > "/etc/sudoers.d/$USERNAME" \
    && chmod 0440 "/etc/sudoers.d/$USERNAME"

RUN rustup component add rustfmt clippy

RUN printf '%s\n' 'export PATH="/usr/local/cargo/bin:${PATH}"' > /etc/profile.d/rust-cargo-path.sh

USER $USERNAME
WORKDIR /workspaces/codex-desktop-linux
