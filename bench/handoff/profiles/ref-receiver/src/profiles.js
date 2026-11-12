// A stored record: { id, display_name } after the data team's rename, { id, fullname } before it.
// Both load, display_name first; fullname stays readable until the data team confirms the backfill.
export function loadProfile(record) {
  return { id: record.id, name: record.display_name ?? record.fullname };
}

export function saveProfile(profile) {
  return { id: profile.id, display_name: profile.name };
}
