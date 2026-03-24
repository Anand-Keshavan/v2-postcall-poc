/**
 * Forge Project Management — GraphQL Mock Server
 *
 * Demonstrates Schema++ grounding chains in a GraphQL context.
 * Authentication: single API key via X-API-Key header.
 *
 * Port: 9000
 * Key:  forge-api-key-postcall-2024
 */

const express = require('express');
const { graphqlHTTP } = require('express-graphql');
const { buildSchema } = require('graphql');

const PORT = 9000;
const API_KEY = 'forge-api-key-postcall-2024';

// ── Mock data ─────────────────────────────────────────────────────────────────

const teams = [
  { id: '1', name: 'Engineering',  description: 'Backend and frontend engineers', memberCount: 8 },
  { id: '2', name: 'Product',      description: 'Product management and strategy', memberCount: 4 },
  { id: '3', name: 'Design',       description: 'UX research and visual design',  memberCount: 3 },
  { id: '4', name: 'Marketing',    description: 'Growth and content marketing',    memberCount: 5 },
];

const members = [
  { id: '101', name: 'Alice Chen',   email: 'alice@forge.io',   role: 'Senior Engineer',    teamId: '1' },
  { id: '102', name: 'Bob Kumar',    email: 'bob@forge.io',     role: 'Frontend Engineer',  teamId: '1' },
  { id: '103', name: 'Carol White',  email: 'carol@forge.io',   role: 'DevOps Engineer',    teamId: '1' },
  { id: '104', name: 'David Lee',    email: 'david@forge.io',   role: 'Product Manager',    teamId: '2' },
  { id: '105', name: 'Eva Martinez', email: 'eva@forge.io',     role: 'Product Designer',   teamId: '3' },
  { id: '106', name: 'Frank Brown',  email: 'frank@forge.io',   role: 'UX Researcher',      teamId: '3' },
  { id: '107', name: 'Grace Kim',    email: 'grace@forge.io',   role: 'Content Strategist', teamId: '4' },
  { id: '108', name: 'Hiro Tanaka',  email: 'hiro@forge.io',    role: 'Growth Manager',     teamId: '4' },
];

const projects = [
  { id: '201', name: 'API Gateway Redesign',   description: 'Modernise the API layer',      status: 'ACTIVE',     teamId: '1' },
  { id: '202', name: 'Mobile App v2',          description: 'New React Native mobile app',  status: 'PLANNING',   teamId: '1' },
  { id: '203', name: 'Q2 Roadmap',             description: 'Product roadmap for Q2',       status: 'ACTIVE',     teamId: '2' },
  { id: '204', name: 'Design System',          description: 'Component library and tokens', status: 'ACTIVE',     teamId: '3' },
  { id: '205', name: 'Brand Refresh',          description: 'New brand guidelines',         status: 'COMPLETED',  teamId: '3' },
  { id: '206', name: 'Launch Campaign',        description: 'Q2 product launch campaign',   status: 'ACTIVE',     teamId: '4' },
];

const tasks = [
  { id: '301', title: 'Implement rate limiting',       status: 'IN_PROGRESS', priority: 'HIGH',     assigneeId: '101', projectId: '201', teamId: '1' },
  { id: '302', title: 'Write API documentation',       status: 'TODO',        priority: 'MEDIUM',   assigneeId: '102', projectId: '201', teamId: '1' },
  { id: '303', title: 'Set up CI/CD pipeline',         status: 'DONE',        priority: 'HIGH',     assigneeId: '103', projectId: '201', teamId: '1' },
  { id: '304', title: 'Design onboarding flow',        status: 'IN_PROGRESS', priority: 'HIGH',     assigneeId: '101', projectId: '202', teamId: '1' },
  { id: '305', title: 'Draft Q2 feature list',         status: 'DONE',        priority: 'CRITICAL', assigneeId: '104', projectId: '203', teamId: '2' },
  { id: '306', title: 'Stakeholder review',            status: 'TODO',        priority: 'HIGH',     assigneeId: '104', projectId: '203', teamId: '2' },
  { id: '307', title: 'Create button components',      status: 'IN_PROGRESS', priority: 'MEDIUM',   assigneeId: '105', projectId: '204', teamId: '3' },
  { id: '308', title: 'Document colour tokens',        status: 'TODO',        priority: 'LOW',      assigneeId: '106', projectId: '204', teamId: '3' },
  { id: '309', title: 'Write launch blog post',        status: 'IN_PROGRESS', priority: 'HIGH',     assigneeId: '107', projectId: '206', teamId: '4' },
  { id: '310', title: 'Create social media assets',    status: 'TODO',        priority: 'MEDIUM',   assigneeId: '108', projectId: '206', teamId: '4' },
];

// ── GraphQL SDL ───────────────────────────────────────────────────────────────

const schema = buildSchema(`
  enum TaskStatus    { TODO IN_PROGRESS DONE BLOCKED }
  enum Priority      { LOW MEDIUM HIGH CRITICAL }
  enum ProjectStatus { PLANNING ACTIVE ON_HOLD COMPLETED }

  type Team {
    id: ID!
    name: String!
    description: String
    memberCount: Int
    members: [Member!]!
    projects: [Project!]!
  }

  type Member {
    id: ID!
    name: String!
    email: String!
    role: String!
    team: Team!
  }

  type Project {
    id: ID!
    name: String!
    description: String
    status: ProjectStatus!
    team: Team!
    tasks: [Task!]!
  }

  type Task {
    id: ID!
    title: String!
    status: TaskStatus!
    priority: Priority!
    assignee: Member
    project: Project!
    team: Team!
  }

  type Query {
    # ── Simple lookups (used as grounding resolvers) ──
    teams: [Team!]!
    team(id: ID!): Team
    teamByName(name: String!): Team

    members: [Member!]!
    member(id: ID!): Member
    memberByName(name: String!): Member

    projects: [Project!]!
    project(id: ID!): Project
    projectByName(name: String!): Project

    tasks: [Task!]!
    task(id: ID!): Task

    # ── Grounding-capable lookups ──
    tasksByTeam(teamId: ID!): [Task!]!
    tasksByProject(projectId: ID!): [Task!]!
    tasksByMember(memberId: ID!): [Task!]!
    projectsByTeam(teamId: ID!): [Project!]!
    membersByTeam(teamId: ID!): [Member!]!
  }
`);

// ── Resolvers ─────────────────────────────────────────────────────────────────

function findByName(collection, name) {
  return collection.find(i => fuzzyMatch(i.name, name)) || null;
}

const root = {
  // Teams
  teams: () => teams,
  team: ({ id }) => teams.find(t => t.id === id) || null,
  teamByName: ({ name }) => findByName(teams, name),

  // Members
  members: () => members,
  member: ({ id }) => members.find(m => m.id === id) || null,
  memberByName: ({ name }) => findByName(members, name),

  // Projects
  projects: () => projects,
  project: ({ id }) => projects.find(p => p.id === id) || null,
  projectByName: ({ name }) => findByName(projects, name),

  // Tasks
  tasks: () => tasks,
  task: ({ id }) => tasks.find(t => t.id === id) || null,

  // Grounding-capable
  tasksByTeam:    ({ teamId })    => tasks.filter(t => t.teamId === teamId),
  tasksByProject: ({ projectId }) => tasks.filter(t => t.projectId === projectId),
  tasksByMember:  ({ memberId })  => tasks.filter(t => t.assigneeId === memberId),
  projectsByTeam: ({ teamId })    => projects.filter(p => p.teamId === teamId),
  membersByTeam:  ({ teamId })    => members.filter(m => m.teamId === teamId),
};

// ── Fuzzy name matching ────────────────────────────────────────────────────────
// Handles:
//   - Case normalization and punctuation stripping
//   - Mustache template markers stripped ({{intent.foo}} → ignored)
//   - All query words present in text ("API Gateway Redesign" ↔ record name)
//   - Any significant word hit (partial / abbreviation match)
//   - Reverse: all significant text words appear in query (embedded name)
function fuzzyMatch(text, query) {
  if (!query) return false;

  const normalize = s => s
    .replace(/\{\{[^}]*\}\}/g, ' ')   // strip {{template}} markers
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const textN  = normalize(text);
  const queryN = normalize(query);

  if (!queryN) return false;  // query normalized to empty — skip

  // Exact substring match in either direction
  if (textN.includes(queryN) || queryN.includes(textN)) return true;

  const queryWords = queryN.split(/\s+/).filter(w => w.length > 2);
  const textWords  = textN.split(/\s+/).filter(w => w.length > 2);

  // All query words appear in the text (handles multi-word project names)
  if (queryWords.length > 1 && queryWords.every(w => textN.includes(w))) return true;

  // Any single query word appears in the text (abbreviation / partial)
  if (queryWords.some(w => textN.includes(w))) return true;

  // All significant text words appear in the query (embedded name lookup)
  if (textWords.length > 0 && textWords.every(w => queryN.includes(w))) return true;

  return false;
}

// ── Field resolvers for nested types ─────────────────────────────────────────

// graphql-http uses root resolvers; we need to attach methods to objects
// returned from root resolvers so nested fields resolve correctly.

function enrichTeam(t) {
  if (!t) return null;
  return {
    ...t,
    members:  () => members.filter(m => m.teamId === t.id).map(enrichMember),
    projects: () => projects.filter(p => p.teamId === t.id).map(enrichProject),
  };
}
function enrichMember(m) {
  if (!m) return null;
  return { ...m, team: () => enrichTeam(teams.find(t => t.id === m.teamId)) };
}
function enrichProject(p) {
  if (!p) return null;
  return {
    ...p,
    team:  () => enrichTeam(teams.find(t => t.id === p.teamId)),
    tasks: () => tasks.filter(t => t.projectId === p.id).map(enrichTask),
  };
}
function enrichTask(t) {
  if (!t) return null;
  return {
    ...t,
    assignee: () => enrichMember(members.find(m => m.id === t.assigneeId)),
    project:  () => enrichProject(projects.find(p => p.id === t.projectId)),
    team:     () => enrichTeam(teams.find(tm => tm.id === t.teamId)),
  };
}

// Wrap root resolvers to enrich nested types
const enrichedRoot = {
  teams:          ()           => teams.map(enrichTeam),
  team:           ({ id })     => enrichTeam(teams.find(t => t.id === id)),
  teamByName:     ({ name })   => enrichTeam(findByName(teams, name)),
  members:        ()           => members.map(enrichMember),
  member:         ({ id })     => enrichMember(members.find(m => m.id === id)),
  memberByName:   ({ name })   => enrichMember(findByName(members, name)),
  projects:       ()           => projects.map(enrichProject),
  project:        ({ id })     => enrichProject(projects.find(p => p.id === id)),
  projectByName:  ({ name })   => enrichProject(findByName(projects, name)),
  tasks:          ()           => tasks.map(enrichTask),
  task:           ({ id })     => enrichTask(tasks.find(t => t.id === id)),
  tasksByTeam:    ({ teamId })    => tasks.filter(t => t.teamId === teamId).map(enrichTask),
  tasksByProject: ({ projectId }) => tasks.filter(t => t.projectId === projectId).map(enrichTask),
  tasksByMember:  ({ memberId })  => tasks.filter(t => t.assigneeId === memberId).map(enrichTask),
  projectsByTeam: ({ teamId })    => projects.filter(p => p.teamId === teamId).map(enrichProject),
  membersByTeam:  ({ teamId })    => members.filter(m => m.teamId === teamId).map(enrichMember),
};

// ── Express app ───────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// API key middleware
app.use('/graphql', (req, res, next) => {
  const key = req.headers['x-api-key'];
  if (!key || key !== API_KEY) {
    return res.status(401).json({ errors: [{ message: 'Unauthorized: provide a valid X-API-Key header' }] });
  }
  next();
});

// GraphQL endpoint
app.use('/graphql', graphqlHTTP({
  schema,
  rootValue: enrichedRoot,
  graphiql: {
    headerEditorEnabled: true,
    defaultHeaders: JSON.stringify({ 'X-API-Key': API_KEY }),
  },
}));

// Docs / key endpoint
app.get('/docs', (req, res) => {
  res.json({
    title: 'Forge Project Management GraphQL API',
    version: '1.0.0',
    graphql_endpoint: `http://localhost:${PORT}/graphql`,
    authentication: {
      type: 'API Key',
      header: 'X-API-Key',
      demo_key: API_KEY,
    },
    note: 'Open /graphql in a browser to use GraphiQL explorer',
  });
});

app.listen(PORT, () => {
  console.log(`\n🔨 Forge GraphQL API running on http://localhost:${PORT}/graphql`);
  console.log(`   API Key: ${API_KEY}`);
  console.log(`   GraphiQL explorer available at http://localhost:${PORT}/graphql\n`);
});

module.exports = app;
