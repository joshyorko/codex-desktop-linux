{ self }:
{ config, lib, pkgs, ... }:
let
  cfg = config.programs.codexDesktopLinux;
  system = pkgs.stdenv.hostPlatform.system;
  selection = import ./package-selection.nix {
    inherit cfg lib;
    flakePackages = self.packages.${system};
  };
  desktopPackage = selection.package;
  remote = cfg.remoteControl;
  codexHome = if remote.codexHome == null then "%h/.codex" else remote.codexHome;
  socket = if remote.listen == "unix://" then "${codexHome}/app-server-control/app-server-control.sock"
    else lib.removePrefix "unix://" remote.listen;
in {
  options.programs.codexDesktopLinux = {
    enable = lib.mkEnableOption "codex-desktop based on OpenAI's official Linux package";
    package = lib.mkOption { type = lib.types.nullOr lib.types.package; default = null; };
    computerUseUi.enable = lib.mkEnableOption "the computer-use-linux feature";
    remoteMobileControl.enable = lib.mkEnableOption "the remote-mobile-control feature";
    linuxFeatures = lib.mkOption {
      type = (import ./linux-features.nix { inherit lib; }).optionType;
      default = [ ];
    };
    remoteControl = {
      enable = lib.mkEnableOption "a system-wide user remote-control app-server unit";
      package = lib.mkOption { type = lib.types.package; default = pkgs.codex; };
      codexHome = lib.mkOption { type = lib.types.nullOr lib.types.str; default = null; };
      listen = lib.mkOption { type = lib.types.str; default = "unix://"; };
      target = lib.mkOption { type = lib.types.str; default = "default.target"; };
      environment = lib.mkOption { type = lib.types.attrsOf lib.types.str; default = { }; };
      environmentFile = lib.mkOption { type = lib.types.nullOr lib.types.str; default = null; };
      extraPackages = lib.mkOption { type = lib.types.listOf lib.types.package; default = [ pkgs.git pkgs.openssh ]; };
      extraArgs = lib.mkOption { type = lib.types.listOf lib.types.str; default = [ ]; };
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = !remote.enable || remote.listen == "unix://" || builtins.match "unix:///[^/].*" remote.listen != null;
        message = "remoteControl.listen must be unix:// or an absolute unix:///path";
      }
    ];
    environment.systemPackages = [ desktopPackage ];
    services.udev.packages = lib.optional (lib.elem "codex-micro" selection.normalizedFeatureIds) desktopPackage;
    environment.sessionVariables = lib.mkIf remote.enable {
      CODEX_REMOTE_CONTROL_APP_SERVER_MODE = "proxy";
      CODEX_REMOTE_CONTROL_APP_SERVER_PROXY_SOCKET = socket;
    };
    systemd.user.services.codex-remote-control = lib.mkIf remote.enable {
      description = "Codex remote-control app-server";
      wantedBy = [ remote.target ];
      serviceConfig = {
        ExecStart = lib.escapeShellArgs ([ (lib.getExe' remote.package "codex") "app-server" "--remote-control" "--listen" remote.listen ] ++ remote.extraArgs);
        Restart = "on-failure";
        Environment = lib.mapAttrsToList (name: value: "${name}=${value}") ({
          CODEX_HOME = codexHome;
          PATH = lib.makeBinPath ([ remote.package ] ++ remote.extraPackages);
        } // remote.environment);
      } // lib.optionalAttrs (remote.environmentFile != null) {
        EnvironmentFile = remote.environmentFile;
      };
    };
  };
}
