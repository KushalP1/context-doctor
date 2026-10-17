/**
 * doctor's verdict must be readable by a script and consistent across apps:
 * exit 1 when a check fails; an app config that is absent or an empty stub
 * (what uninstall leaves) is "not installed" everywhere; a hook is not an
 * issue for an app reported as not there; and doctor itself creates nothing.
 */
export {};
