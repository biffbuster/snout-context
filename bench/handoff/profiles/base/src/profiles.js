// A stored record: { id, fullname }. The app works with { id, name }.
export function loadProfile(record) {
  return { id: record.id, name: record.fullname };
}

export function saveProfile(profile) {
  return { id: profile.id, fullname: profile.name };
}
