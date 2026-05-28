FROM rust:1-bookworm

ARG USERNAME=vscode
ARG USER_UID=1000
ARG USER_GID=$USER_UID

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
        nodejs \
        npm \
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

RUN if ! getent group "$USER_GID" >/dev/null; then groupadd --gid "$USER_GID" "$USERNAME"; fi \
    && if ! getent passwd "$USER_UID" >/dev/null; then useradd --uid "$USER_UID" --gid "$USER_GID" -m "$USERNAME" --shell /bin/bash; fi \
    && echo "$USERNAME ALL=(root) NOPASSWD:ALL" > "/etc/sudoers.d/$USERNAME" \
    && chmod 0440 "/etc/sudoers.d/$USERNAME"

RUN rustup component add rustfmt clippy

RUN printf '%s\n' 'export PATH="/usr/local/cargo/bin:${PATH}"' > /etc/profile.d/rust-cargo-path.sh

USER $USERNAME
WORKDIR /workspaces/codex-desktop-linux
