import assert from 'node:assert/strict';
import { groupProjects, placeChoices, placeLabel, rankPlaces } from './projectPlaces.mjs';

// groupProjects merges checkouts of the same remote across ranches; local-only repos stay singletons
{
  const ranches = [
    { id: 'origin', name: 'MarkPC', live: true, telemetry: { busy: 0 }, checkouts: [
      { dir: 'E:/Projects/corral', remote: 'github.com/mapika/corral', name: 'corral', lastSeen: 100 },
      { dir: 'E:/Scratch/notes', remote: null, name: 'notes', lastSeen: 50 },
    ] },
    { id: 'r2', name: 'homelab', live: true, telemetry: { busy: 2 }, checkouts: [
      { dir: '/home/m/corral', remote: 'github.com/mapika/corral', name: 'corral', lastSeen: 90 },
    ] },
    { id: 'r3', name: 'office', live: false, checkouts: [] },
  ];
  const projects = groupProjects(ranches);
  assert.deepEqual(projects.map((p) => p.key), ['github.com/mapika/corral', 'origin\0E:/Scratch/notes']);
  assert.equal(projects[0].places.length, 2);
  assert.equal(projects[0].places[1].ranchName, 'homelab');
  assert.equal(projects[1].remote, null);
  assert.equal(projects[1].places.length, 1);
}
assert.deepEqual(groupProjects([]), []);

// rankPlaces: live > plugged-in > least busy > most free memory; unknown telemetry isn't punished
{
  const places = [
    { ranch: 'a', ranchName: 'laptop', live: true, telemetry: { onBattery: true, busy: 0, memFree: 99 } },
    { ranch: 'b', ranchName: 'desk', live: true, telemetry: { onBattery: false, busy: 2, memFree: 8 } },
    { ranch: 'c', ranchName: 'homelab', live: true, telemetry: { onBattery: false, busy: 0, memFree: 4 } },
    { ranch: 'd', ranchName: 'office', live: false, telemetry: { onBattery: false, busy: 0, memFree: 64 } },
    { ranch: 'e', ranchName: 'mystery', live: true, telemetry: null },
  ];
  assert.deepEqual(rankPlaces(places).map((p) => p.ranch), ['c', 'e', 'b', 'a', 'd']);
}
// memFree breaks the tie between two idle plugged-in ranches
{
  const ranked = rankPlaces([
    { ranch: 'small', live: true, telemetry: { busy: 0, memFree: 4 } },
    { ranch: 'big', live: true, telemetry: { busy: 0, memFree: 32 } },
  ]);
  assert.equal(ranked[0].ranch, 'big');
}

// placeLabel: operator words, shortest true thing
assert.equal(placeLabel({ ranchName: 'MarkPC', live: true, telemetry: { onBattery: false, busy: 0 } }), 'MarkPC · idle');
assert.equal(placeLabel({ ranchName: 'homelab', live: true, telemetry: { busy: 2 } }), 'homelab · 2 busy');
assert.equal(placeLabel({ ranchName: 'laptop', live: true, telemetry: { onBattery: true } }), 'laptop · on battery');
assert.equal(placeLabel({ ranchName: 'office', live: false }), 'office · offline');
assert.equal(placeLabel(null), '');

// placeChoices: only for identified projects with a real choice
{
  const two = { remote: 'github.com/x/y', places: [{ ranch: 'a', live: true }, { ranch: 'b', live: true }] };
  assert.equal(placeChoices(two).length, 2);
  assert.equal(placeChoices({ remote: 'github.com/x/y', places: [{ ranch: 'a' }] }), null);
  assert.equal(placeChoices({ remote: null, places: [{ ranch: 'a' }, { ranch: 'b' }] }), null);
  assert.equal(placeChoices(null), null);
}

console.log('projectPlaces tests ok');
