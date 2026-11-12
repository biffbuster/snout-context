// A stored record: { id, display_name } after the data team's rename, { id, fullname } before it.
// Both load, display_name first. The app works with { id, name }.
export function loadProfile(record) {
  return { id: record.id, name: record.display_name ?? record.fullname };
}

export function saveProfile(profile) {
  return { id: profile.id, fullname: profile.name };
}
