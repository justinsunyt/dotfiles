{ lib, ... }:

{
  system.defaults = {
    NSGlobalDomain = {
      AppleInterfaceStyle = "Dark";
      AppleShowAllExtensions = true;
      NSAutomaticCapitalizationEnabled = false;
      NSAutomaticDashSubstitutionEnabled = false;
      NSAutomaticInlinePredictionEnabled = false;
      NSAutomaticPeriodSubstitutionEnabled = false;
      NSAutomaticQuoteSubstitutionEnabled = false;
      NSAutomaticSpellingCorrectionEnabled = false;
      "com.apple.trackpad.forceClick" = false;
    };

    CustomUserPreferences = {
      NSGlobalDomain = {
        AppleAccentColor = 0;
        AppleHighlightColor = "1.000000 0.733333 0.721569 Red";
        NSSmartReplyEnabled = false;
        "com.apple.mouse.linear" = true;
        "com.apple.mouse.scaling" = 0.6875;
      };

      "com.apple.controlcenter" = {
        "NSStatusItem Visible Battery" = true;
        "NSStatusItem Visible ScreenMirroring" = false;
        "NSStatusItem Visible WiFi" = true;
      };
    };

    WindowManager.HideDesktop = true;

    controlcenter = {
      Bluetooth = true;
      NowPlaying = true;
      Sound = false;
    };

    dock = {
      autohide = true;
      autohide-delay = 0.0;
      autohide-time-modifier = 0.15;
      launchanim = false;
      mineffect = "scale";
      show-recents = false;
      tilesize = 65;
      wvous-br-corner = 4;
    };

    finder = {
      FXPreferredViewStyle = "icnv";
      NewWindowTarget = "Home";
      ShowExternalHardDrivesOnDesktop = true;
      ShowHardDrivesOnDesktop = false;
      ShowPathbar = true;
      ShowRemovableMediaOnDesktop = true;
      ShowStatusBar = true;
    };

    menuExtraClock = {
      ShowAMPM = true;
      ShowDate = 0;
      ShowDayOfWeek = true;
    };

    spaces.spans-displays = false;

    trackpad = {
      Clicking = true;
      TrackpadCornerSecondaryClick = 2;
      TrackpadRightClick = false;
    };
  };

  system.activationScripts.postActivation.text = lib.mkAfter ''
    echo >&2 "configuring charger power policy..."
    /usr/bin/pmset -c \
      sleep 0 \
      displaysleep 180 \
      disksleep 10 \
      lowpowermode 2 \
      womp 1 \
      powernap 1 \
      ttyskeepawake 1
  '';
}
