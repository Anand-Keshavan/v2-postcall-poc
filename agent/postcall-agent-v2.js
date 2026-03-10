/**
 * PostCall AI Agent v2
 * Complete implementation with:
 * - RAG-based operation matching using OpenAI
 * - Interactive browser-based auth provisioning
 * - Automatic grounding execution
 * - Natural language interface
 */

const readline = require('readline');
const fs = require('fs');
const path = require('path');
const yaml = require('yaml');
const { getToken, storeToken, hasToken } = require('../lib/token-storage');
const { createClientFromSpec } = require('../lib/api-client-simple');
const { executeGroundingChain, findOperation } = require('../lib/grounding-executor');
const { loadIndex, buildIndex, matchQuery, matchQueryTopN, getOpenAIKey, getIndexStats } = require('../lib/rag-matcher');
const { rerankCandidates } = require('../lib/candidate-reranker');
const { requestAuthForSpec } = require('../lib/console-auth');
const { generatePlan, executePlan, getAllOperations } = require('../lib/reasoning-planner');
const { generateDocAwarePlan, enrichPlanForCompleteness } = require('../lib/doc-aware-planner');
const { enrichResponse } = require('../lib/response-enricher');
const { retrieveDocumentation, formatForHuman } = require('../lib/doc-retriever');
const contextStore = require('../lib/context-store');
const abortSignal = require('../lib/abort-signal');

// Load OAS++ specs (REST) and Schema++ specs (GraphQL)
const specs = {};       // REST OAS++ specs keyed by api name
const schemaSpecs = {}; // GraphQL Schema++ specs keyed by api name

async function loadSpecs() {
  const specsDir = path.join(__dirname, '../specs');
  const specFiles = {
    github: 'github-oas-plus.yaml',
    confluence: 'confluence-oas-plus.yaml',
    nile: 'nile-oas-plus.yaml',
  };
  const schemaFiles = {
    forge: 'forge-schema-plus.yaml',
  };

  for (const [api, filename] of Object.entries(specFiles)) {
    const filepath = path.join(specsDir, filename);
    try {
      const content = fs.readFileSync(filepath, 'utf8');
      specs[api] = yaml.parse(content);
    } catch (error) {
      console.error(`Failed to load ${api} spec:`, error.message);
    }
  }

  // Load Schema++ (GraphQL) specs
  for (const [api, filename] of Object.entries(schemaFiles)) {
    const filepath = path.join(specsDir, filename);
    try {
      const content = fs.readFileSync(filepath, 'utf8');
      schemaSpecs[api] = yaml.parse(content);
      console.log(`[PostCall] ✓ Loaded Schema++ spec: ${api} (${Object.keys(schemaSpecs[api].operations || {}).length} operations)`);
    } catch (error) {
      console.error(`Failed to load ${api} schema spec:`, error.message);
    }
  }

  // Load RAG index (pre-built or fallback to building)
  console.log('[PostCall] Loading RAG index...');
  const indexLoaded = loadIndex();

  if (!indexLoaded) {
    // Fallback: build index from specs
    await buildIndex(specs);
  }

  if (getOpenAIKey()) {
    console.log('[PostCall] ✓ OpenAI enabled - Using semantic matching');
  } else {
    console.log('[PostCall] ○ OpenAI not configured - Using keyword matching');
    console.log('[PostCall]   Set OPENAI_API_KEY for better query understanding\n');
  }
}

/**
 * Get x-postcall-auth-discovery from whichever spec type covers this API.
 */
function getAuthDiscovery(api) {
  return specs[api]?.info?.['x-postcall-auth-discovery']
      || schemaSpecs[api]?.info?.['x-postcall-auth-discovery']
      || null;
}

/**
 * Get provisioning URL from whichever spec type covers this API.
 */
function getProvisioningUrl(api) {
  return specs[api]?.info?.['x-postcall-provisioning-url']
      || schemaSpecs[api]?.info?.['x-postcall-provisioning-url']
      || null;
}

/**
 * Execute the full PostCall flow with multi-step reasoning
 */
async function executeQuery(query) {
  abortSignal.reset();
  console.log(`\n🤖 PostCall Reasoning Agent`);
  console.log(`   Query: "${query}"\n`);

  // 1. Match query to operations using RAG, then re-rank with gpt-5.4
  console.log('[1/5] Analyzing query...');
  let candidates = await matchQueryTopN(query, 3);

  if (candidates.length === 0) {
    console.log('❌ Could not understand the query.');
    console.log('\n   Supported queries:');
    console.log('   • "list my repositories"');
    console.log('   • "show me issues in my test-repo"');
    console.log('   • "list spaces in Confluence"');
    console.log('   • "find pages created by Anand"\n');
    return;
  }

  console.log(`      ✓ RAG matches:`);
  candidates.forEach((c, i) =>
    console.log(`        ${i + 1}. ${c.api} / ${c.operationId} (${(c.confidence * 100).toFixed(0)}%)`)
  );

  if (candidates.length > 1) {
    console.log(`      → Re-ranking with gpt-5.4...`);
    candidates = await rerankCandidates(query, candidates);
  }

  // 2. Generate plans for all viable candidates (collect all, don't stop at first)
  console.log('\n[2/5] Creating execution plans...');
  const viablePlans = [];

  for (let ci = 0; ci < candidates.length; ci++) {
    const candidate = candidates[ci];

    if (candidate.hasDocumentation) {
      console.log(`      → Planning ${candidate.api} / ${candidate.operationId}...`);
      const documentation = retrieveDocumentation(candidate.api, candidate.operationId, candidate);

      const candidatePlan = await generateDocAwarePlan(query, { ...candidate, documentation }, []);

      if (candidatePlan.canFulfill === false) {
        console.log(`      ✗ ${candidate.operationId} cannot fulfill: ${candidatePlan.reasoning}`);
        if (candidatePlan.suggestedOperation) {
          console.log(`        (Suggested: ${candidatePlan.suggestedOperation})`);
        }
        continue; // skip this candidate
      }

      viablePlans.push({ plan: candidatePlan, match: candidate });
      console.log(`      ✓ ${candidate.operationId} viable`);
      if (candidatePlan.usesGrounding) {
        console.log(`        → Will use grounding chain to resolve parameters`);
      }
      if (candidatePlan.warnings && candidatePlan.warnings.length > 0) {
        candidatePlan.warnings.forEach(w => console.log(`        ⚠ ${w}`));
      }

    } else {
      // No documentation — fall back to standard planning
      const availableOps = getAllOperations(specs);
      const candidatePlan = await generatePlan(query, availableOps, specs);
      viablePlans.push({ plan: candidatePlan, match: candidate });
      console.log(`      ✓ ${candidate.operationId} viable (no documentation)`);
    }
  }

  if (viablePlans.length === 0) {
    console.log('❌ No available operation can fulfill this query');
    return;
  }

  console.log(`      ✓ ${viablePlans.length} viable plan(s) to try`);

  // Enrich the top-ranked plan: check completeness and append missing steps
  console.log(`      → Checking plan completeness...`);
  const allOps = [
    ...getAllOperations(specs).map(op => ({
      api: op.api,
      operationId: op.operationId,
      summary: op.operation.summary || '',
      operation: op.operation,
    })),
    ...Object.entries(schemaSpecs).flatMap(([api, schema]) =>
      Object.entries(schema.operations || {}).map(([opId, op]) => ({
        api,
        operationId: opId,
        summary: op.description || opId,
        operation: op,
      }))
    ),
  ];
  viablePlans[0].plan = await enrichPlanForCompleteness(query, viablePlans[0].plan, allOps);

  // 3. Check authentication — driven entirely by x-postcall-auth-discovery in each spec
  console.log('\n[3/5] Checking authentication...');
  // Exclude action steps — they have no api field and need no credentials
  const allApisNeeded = [...new Set(
    viablePlans.flatMap(vp => vp.plan.steps.filter(s => s.stepType !== 'action').map(s => s.api))
  )];

  for (const api of allApisNeeded) {
    const authDiscovery = getAuthDiscovery(api);

    if (!authDiscovery || authDiscovery.type === 'none') {
      console.log(`      ✓ ${api} - no authentication required`);
      continue;
    }

    if (authDiscovery.type === 'api_key' && authDiscovery.api_key) {
      console.log(`      ✓ ${api} - API key embedded in spec`);
      continue;
    }

    const tokenData = getToken(api);
    if (!tokenData) {
      console.log(`      ⚠ No credentials found for ${api}`);
      const provisioningUrl = getProvisioningUrl(api);
      const authData = await requestAuthForSpec(api, authDiscovery, provisioningUrl);
      storeToken(api, authData);
      console.log(`      ✓ Credentials stored for ${api}`);
    } else {
      console.log(`      ✓ Using stored credentials for ${api}`);
    }
  }

  // 4. Create API clients — driven by spec auth type and server URL
  console.log('\n[4/5] Creating API clients...');
  const clients = {};

  for (const api of allApisNeeded) {
    try {
      clients[api] = await createClientFromSpec(api, specs[api], schemaSpecs[api]);
      console.log(`      ✓ ${api} client ready`);
    } catch (clientError) {
      console.error(`      ✗ Failed to create ${api} client: ${clientError.message}`);
      throw clientError;
    }
  }

  // 5. Try executing each viable plan in order; fall through to next on failure
  console.log('\n[5/5] Executing plan...');

  if (contextStore.hasContext()) {
    console.log(`      ℹ ${contextStore.getFactCount()} prior fact(s) available in context store`);
  }

  for (let pi = 0; pi < viablePlans.length; pi++) {
    const { plan, match } = viablePlans[pi];

    if (viablePlans.length > 1) {
      console.log(`\n      → Attempt ${pi + 1}/${viablePlans.length}: ${match.api} / ${match.operationId}`);
    }

    try {
      const execution = await executePlan(plan, specs, schemaSpecs, clients, match.intent, query);

      // ── Embed and store API step results (skip action steps) ──
      console.log('\n[Context] Indexing results into vector store...');
      await Promise.all(
        execution.results
          .filter(r => !r.operationId?.startsWith('action:'))
          .map(r => {
            const stepDef = plan.steps.find(s => s.stepNumber === r.step);
            const api = stepDef?.api || 'unknown';
            return contextStore.addResult(api, r.operationId, query, r.data);
          })
      );

      // Show the last PRIMARY step's API result (before completeness-added steps)
      const apiResults = execution.results.filter(r => !r.operationId?.startsWith('action:'));
      const actionResults = execution.results.filter(r => r.operationId?.startsWith('action:'));

      if (apiResults.length > 0) {
        // Always show the last API step's result — it is the final answer.
        // enrichPlanForCompleteness uses grounding-chain awareness to avoid adding
        // redundant lookup steps, so the last step is always meaningful.
        const displayResult = apiResults[apiResults.length - 1];

        // Determine API name and protocol from the step definition
        const stepDef = plan.steps.find(s => s.stepNumber === displayResult.step);
        const apiName = stepDef?.api || 'unknown';
        const protocol = schemaSpecs[apiName] ? 'GraphQL' : 'REST';

        // Generate enriched summary (resolves IDs if possible, always returns text)
        const summary = await enrichResponse(displayResult.data, displayResult.operationId, allOps, clients, specs, schemaSpecs, query);

        // ── Standard response format ─────────────────────────────────────────
        console.log('\n═══════════════════════════════════════════════════════════\n');
        console.log(`Your Query   : ${query}`);
        console.log(`API (${protocol.padEnd(7)}): ${apiName}`);
        console.log(`\nResponse (Raw JSON):\n`);
        console.log('```json');
        console.log(JSON.stringify(displayResult.data, null, 2));
        console.log('```');
        if (summary) {
          console.log(`\nSummary:\n`);
          console.log(`  ${summary}`);
        }
      }

      // Show action step outcomes (e.g. opened URLs)
      for (const ar of actionResults) {
        if (ar.operationId === 'action:open-url') {
          const { opened } = ar.data;
          if (opened?.length > 0) {
            console.log(`\n🌐 Opened ${opened.length} URL(s) in browser:`);
            opened.forEach(url => console.log(`   • ${url}`));
          }
        }
      }

      console.log('\n═══════════════════════════════════════════════════════════\n');
      return; // done

    } catch (error) {
      if (pi < viablePlans.length - 1) {
        console.log(`      ✗ ${match.operationId} failed: ${error.message}`);
        console.log(`      → Trying next candidate...`);
      } else {
        // Last candidate — surface the error
        console.error(`\n❌ Error: ${error.message}\n`);
        if (error.code === 'auth_required_challenge') {
          console.log('Your token may be invalid or expired.');
        }
        if (process.env.DEBUG === 'true' && error.stack) {
          console.error(error.stack);
        }
      }
    }
  }
}

/**
 * Build API request from operation and parameters
 */
function buildRequest(operation, intent, resolvedParams) {
  const { path, method } = operation;

  // Resolve path parameters
  let url = path.replace(/\{([^}]+)\}/g, (match, param) => {
    return resolvedParams[param] || intent[param] || match;
  });

  return {
    method: method.toLowerCase(),
    url,
  };
}

/**
 * Display results in a user-friendly format
 */
function displayResults(operationId, data) {
  if (operationId === 'listIssues') {
    if (Array.isArray(data) && data.length > 0) {
      console.log(`📋 Found ${data.length} issue(s):\n`);
      data.slice(0, 10).forEach((issue, i) => {
        console.log(`${i + 1}. #${issue.number}: ${issue.title}`);
        console.log(`   State: ${issue.state}`);
        console.log(`   URL: ${issue.html_url}\n`);
      });
      if (data.length > 10) {
        console.log(`... and ${data.length - 10} more`);
      }
    } else {
      console.log('No issues found.');
    }
  } else if (operationId === 'listSpaces') {
    if (data.results && data.results.length > 0) {
      console.log(`📚 Found ${data.results.length} space(s):\n`);
      data.results.forEach((space, i) => {
        console.log(`${i + 1}. ${space.name}`);
        console.log(`   Key: ${space.key} | Type: ${space.type}\n`);
      });
    } else {
      console.log('No spaces found.');
    }
  } else if (operationId === 'searchContent') {
    if (data.results && data.results.length > 0) {
      console.log(`🔍 Found ${data.results.length} result(s):\n`);
      data.results.forEach((item, i) => {
        console.log(`${i + 1}. ${item.title} (${item.type})`);
        if (item.space) {
          console.log(`   Space: ${item.space.name}\n`);
        }
      });
    } else {
      console.log('No results found.');
    }
  } else if (operationId === 'listUserRepos') {
    if (Array.isArray(data) && data.length > 0) {
      console.log(`📦 Found ${data.length} repositories:\n`);
      data.slice(0, 10).forEach((repo, i) => {
        console.log(`${i + 1}. ${repo.full_name}`);
        console.log(`   ${repo.description || 'No description'}`);
        console.log(`   ${repo.html_url}\n`);
      });
      if (data.length > 10) {
        console.log(`... and ${data.length - 10} more`);
      }
    } else {
      console.log('No repositories found.');
    }
  } else if (Array.isArray(data) && data.length > 0 && data[0]?.title !== undefined) {
    // Tasks array (listTasksByTeam, listTasksByProject, listTasksByMember)
    console.log(`✅ Found ${data.length} task(s):\n`);
    data.forEach((task, i) => {
      console.log(`${i + 1}. ${task.title}`);
      console.log(`   Status: ${task.status} | Priority: ${task.priority}`);
      if (task.assignee) console.log(`   Assignee: ${task.assignee.name}`);
      if (task.project) console.log(`   Project: ${task.project.name}`);
      console.log('');
    });
  } else if (Array.isArray(data) && data.length > 0 && data[0]?.memberCount !== undefined) {
    // Teams array (listTeams)
    console.log(`🏢 Found ${data.length} team(s):\n`);
    data.forEach((team, i) => {
      console.log(`${i + 1}. ${team.name}`);
      console.log(`   ${team.description || ''}`);
      if (team.memberCount !== undefined) console.log(`   Members: ${team.memberCount}`);
      console.log('');
    });
  } else if (Array.isArray(data) && data.length > 0 && data[0]?.email !== undefined) {
    // Members array (listAllMembers, listMembersByTeam)
    console.log(`👥 Found ${data.length} member(s):\n`);
    data.forEach((member, i) => {
      console.log(`${i + 1}. ${member.name} — ${member.role}`);
      console.log(`   Email: ${member.email}`);
      if (member.team) console.log(`   Team: ${member.team.name}`);
      console.log('');
    });
  } else if (Array.isArray(data) && data.length > 0 && data[0]?.status !== undefined && data[0]?.team !== undefined) {
    // Projects array (listAllProjects, listProjectsByTeam)
    console.log(`📂 Found ${data.length} project(s):\n`);
    data.forEach((project, i) => {
      console.log(`${i + 1}. ${project.name} [${project.status}]`);
      console.log(`   ${project.description || ''}`);
      if (project.team) console.log(`   Team: ${project.team.name}`);
      console.log('');
    });
  } else {
    // Generic display
    console.log(JSON.stringify(data, null, 2).substring(0, 1000));
  }
}

/**
 * Interactive REPL
 */
async function startREPL() {
  await loadSpecs();

  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║         PostCall Reasoning Agent - Ready!                  ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');
  console.log('I can understand complex queries and create multi-step execution plans.\n');
  console.log('Examples:');
  console.log('  • "list my repositories"');
  console.log('  • "show me issues in my test-repo"');
  console.log('  • "list spaces in Confluence"');
  console.log('  • "search for Onboarding"\n');
  console.log('Type "exit" to quit\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // Escape key → abort the running operation (between steps / between retries)
  if (process.stdin.isTTY) {
    readline.emitKeypressEvents(process.stdin, rl);
    process.stdin.on('keypress', (_str, key) => {
      if (key && key.name === 'escape' && !abortSignal.isAborted()) {
        abortSignal.abort();
        process.stdout.write('\n⚠ Esc pressed — aborting after current step...\n');
      }
    });
  }

  const prompt = () => {
    rl.question('You: ', async (query) => {
      if (!query.trim()) {
        prompt();
        return;
      }

      if (query.trim().toLowerCase() === 'exit') {
        console.log('\nGoodbye! 👋\n');
        rl.close();
        process.exit(0);
      }

      await executeQuery(query.trim());
      console.log('');
      prompt();
    });
  };

  prompt();
}

// Export for programmatic use
module.exports = {
  executeQuery,
  loadSpecs,
};

// Run REPL if executed directly
if (require.main === module) {
  startREPL();
}
