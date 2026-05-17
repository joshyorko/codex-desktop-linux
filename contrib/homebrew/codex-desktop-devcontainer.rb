cask "codex-desktop-devcontainer" do
  version "devcontainerweb.202605171903"
  sha256 "46464f5dcb10c3aef16207d9558bc40a24e8670915a9e1bb761d09a7338ec8e2"

  url "https://github.com/joshyorko/homebrew-tools/releases/download/codex-desktop-linux-devcontainerweb.202605171903/codex-desktop-linux-devcontainerweb.202605171903.tar.gz"
  name "Codex Desktop Devcontainer"
  desc "Devcontainer-installable Codex Desktop Linux runtime"
  homepage "https://github.com/joshyorko/codex-desktop-linux"

  livecheck do
    skip "Local devcontainer file cask; do not publish this file."
  end

  depends_on formula: "desktop-file-utils"

  binary "bin/codex-desktop", target: "codex-desktop"
  artifact "share/applications/codex-desktop.desktop",
           target: "#{Dir.home}/.local/share/applications/codex-desktop.desktop"
  artifact "share/icons/hicolor/512x512/apps/codex-desktop.png",
           target: "#{Dir.home}/.local/share/icons/hicolor/512x512/apps/codex-desktop.png"
  artifact "share/icons/hicolor/256x256/apps/codex-desktop.png",
           target: "#{Dir.home}/.local/share/icons/hicolor/256x256/apps/codex-desktop.png"

  preflight do
    FileUtils.mkdir_p "#{Dir.home}/.local/share/applications"
    FileUtils.mkdir_p "#{Dir.home}/.local/share/icons/hicolor/512x512/apps"
    FileUtils.mkdir_p "#{Dir.home}/.local/share/icons/hicolor/256x256/apps"

    desktop_file = "#{staged_path}/share/applications/codex-desktop.desktop"
    desktop_contents = File.read(desktop_file)
    desktop_contents.gsub!(/^Exec=.*/, "Exec=#{HOMEBREW_PREFIX}/bin/codex-desktop %U")
    desktop_contents.gsub!(
      /^Icon=.*/,
      "Icon=#{Dir.home}/.local/share/icons/hicolor/512x512/apps/codex-desktop.png"
    )
    desktop_contents << "StartupWMClass=Codex\n" unless desktop_contents.match?(/^StartupWMClass=/)
    desktop_contents << "X-GNOME-WMClass=Codex\n" unless desktop_contents.match?(/^X-GNOME-WMClass=/)

    mime_type = "MimeType=x-scheme-handler/codex;x-scheme-handler/codex-browser-sidebar;"
    if desktop_contents.match?(/^MimeType=/)
      desktop_contents.gsub!(/^MimeType=.*/, mime_type)
    else
      desktop_contents << "#{mime_type}\n"
    end
    File.write(desktop_file, desktop_contents)
  end

  postflight do
    applications_dir = "#{Dir.home}/.local/share/applications"
    desktop_id = "codex-desktop.desktop"
    desktop_target = "#{applications_dir}/#{desktop_id}"
    xdg_mime = [
      "/usr/bin/xdg-mime",
      "/bin/xdg-mime",
      "#{HOMEBREW_PREFIX}/bin/xdg-mime",
    ].find { |path| File.executable?(path) }
    update_desktop_database = [
      "/usr/bin/update-desktop-database",
      "/bin/update-desktop-database",
      "#{HOMEBREW_PREFIX}/bin/update-desktop-database",
    ].find { |path| File.executable?(path) }

    FileUtils.chmod 0755, desktop_target if File.exist?(desktop_target)
    if xdg_mime
      system xdg_mime, "default", desktop_id, "x-scheme-handler/codex"
      system xdg_mime, "default", desktop_id, "x-scheme-handler/codex-browser-sidebar"
    end
    system update_desktop_database, applications_dir if update_desktop_database
  end

  zap trash: [
    "#{Dir.home}/.local/share/applications/codex-desktop.desktop",
    "#{Dir.home}/.local/share/icons/hicolor/512x512/apps/codex-desktop.png",
    "#{Dir.home}/.local/share/icons/hicolor/256x256/apps/codex-desktop.png",
  ]

  caveats <<~EOS
    This file cask is for devcontainer validation only; do not publish it yet.

    Validate from this checkout with the RoR/Wolfi Linuxbrew image:
      ./scripts/devcontainer-homebrew-smoke.sh

    Or copy this cask into a throwaway local tap and install:
      brew install --cask codex-devcontainer/local/codex-desktop-devcontainer

    Launch and inspect:
      codex-desktop --help
      codex-desktop web --inspect
      codex-desktop doctor
      codex-desktop serve --workspace /workspace --profile /workspace/.codex-desktop

    Real devcontainer web-mode browser smoke:
      ./scripts/devcontainer-codex-desktop-browser-smoke.sh

    Web mode serves the extracted Codex Desktop UI on 127.0.0.1 only, persists
    profile state under the selected workspace profile, uses container-local
    Chromium/CDP for Browser Use, and keeps Computer Use browser-only unless an
    explicitly owned virtual display mode is added.
  EOS
end
