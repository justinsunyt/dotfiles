{ lib, ... }:

{
  system.defaults = {
    NSGlobalDomain = {
      AppleShowAllExtensions = true;
      NSAutomaticCapitalizationEnabled = false;
      NSAutomaticDashSubstitutionEnabled = false;
      NSAutomaticPeriodSubstitutionEnabled = false;
      NSAutomaticQuoteSubstitutionEnabled = false;
      NSAutomaticSpellingCorrectionEnabled = false;
    };

    CustomUserPreferences.NSGlobalDomain = {
      "com.apple.mouse.linear" = true;
      "com.apple.mouse.scaling" = 0.6875;
    };

    dock = {
      autohide = true;
      autohide-delay = 0.0;
      autohide-time-modifier = 0.15;
      launchanim = false;
      mineffect = "scale";
      show-recents = false;
      tilesize = 65;
    };

    finder = {
      ShowPathbar = true;
      ShowStatusBar = true;
    };

    spaces.spans-displays = false;
  };

  # Preserve the current plugged-in development-machine policy without
  # imposing it on battery operation.
  system.activationScripts.postActivation.text = lib.mkAfter ''
    echo >&2 "configuring charger power policy..."
    /usr/bin/pmset -c \
      sleep 0 \
      displaysleep 180 \
      disksleep 10 \
      womp 1 \
      powernap 1 \
      ttyskeepawake 1
  '';
}
