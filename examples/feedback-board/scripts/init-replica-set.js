const config = {
  _id: 'rs0',
  members: [
    { _id: 0, host: 'mongo1:27017' },
    { _id: 1, host: 'mongo2:27017' },
    { _id: 2, host: 'mongo3:27017' }
  ]
};

for (const member of config.members) {
  let reachable = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      reachable = new Mongo(member.host).getDB('admin').runCommand({ ping: 1 }).ok === 1;
      if (reachable) break;
    } catch { }
    sleep(1_000);
  }
  if (!reachable) throw new Error(`Replica-set member ${member.host} did not become reachable.`);
}

try {
  rs.status();
} catch {
  rs.initiate(config);
}

let ready = false;
for (let attempt = 0; attempt < 90; attempt += 1) {
  try {
    const status = rs.status();
    ready = status.members.length === 3
      && status.members.some((member) => member.stateStr === 'PRIMARY')
      && status.members.filter((member) => ['PRIMARY', 'SECONDARY'].includes(member.stateStr)).length === 3;
    if (ready) break;
  } catch { }
  sleep(1_000);
}

if (!ready) throw new Error('Three-member replica set did not become healthy.');
print('Replica set rs0 is healthy.');
