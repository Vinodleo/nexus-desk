import { useCallback, useState } from "react";
import { DEFAULT_TRAIL_PROFILE, TRAIL_PROFILES, type TrailProfileId } from "../shared/trailingStop";

const STORAGE_KEY = "nexus_trail_profile_v1";

function load(): TrailProfileId {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v && v in TRAIL_PROFILES ? (v as TrailProfileId) : DEFAULT_TRAIL_PROFILE;
  } catch {
    return DEFAULT_TRAIL_PROFILE;
  }
}

/** The trailing-stop profile new positions use, chosen in the Lab and kept in this browser. */
export function useTrailProfile() {
  const [profile, setProfileState] = useState<TrailProfileId>(load);
  const setProfile = useCallback((next: TrailProfileId) => {
    setProfileState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {}
  }, []);
  return { profile, setProfile };
}
