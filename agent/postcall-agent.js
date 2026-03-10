/**
 * PostCall AI Agent
 * Accepts natural language queries and executes API operations
 *
 * Flow:
 * 1. User: "Show me issues in my test-repo"
 * 2. Agent: Matches to operation using x-agent-guidance
 * 3. Agent: Extracts intent (repo_name: "test-repo")
 * 4. Agent: Checks for auth token
 * 5. Agent: If no token, shows provisioning URL and waits
 * 6. Agent: Executes grounding chain
 * 7. Agent: Makes API call
 * 8. Agent: Returns results in natural language
 */

const readline = require('readline');
const fs = require('fs');
const path = require('path');
const yaml = require('yaml');

const { getToken, storeToken, hasToken } = require('../lib/token-storage');
const { createGitHubClient, createConfluenceClient, fetchConfluenceCloudId } = require('../lib/api-client-simple');
const { executeGroundingChain, findOperation } = require('../lib/grounding-executor');

// Load OAS++ specs
const specs = {};

function loadSpecs() {
  const specsDir = path.join(__dirname, '../specs');
  const specFiles = {
    github: 'github-oas-plus.yaml',
    confluence: 'confluence-oas-plus.yaml',
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
}

/**
 * Match natural language query to operation using x-agent-guidance
 */
function matchQueryToOperation(query) {
  const queryLower = query.toLowerCase().trim();

  for (const [api, spec] of Object.entries(specs)) {
    for (const [path, pathItem] of Object.entries(spec.paths || {})) {
      for (const [method, operation] of Object.entries(pathItem)) {
        if (typeof operation !== 'object' || !operation['x-agent-guidance']) continue;

        const guidance = operation['x-agent-guidance'];
        for (const template of guidance) {
          // Create flexible regex pattern from template
          // Replace {param} with named capture group
          const pattern = template
            .toLowerCase()
            .replace(/\{(\w+)\}/g, '(?<$1>[\\w-]+)')
            .replace(/\s+/g, '\\s+'); // Handle multiple spaces

          // Try to match with word boundaries
          const regex = new RegExp(pattern, 'i');
          const match = queryLower.match(regex);

          if (match && match.groups) {
            return {
              api,
              operationId: operation.operationId,
              operation,
              intent: match.groups,
              confidence: 1.0,
            };
          }

          // Also try fuzzy matching - check if key words match
          const templateWords = template.toLowerCase().split(/\s+/).filter(w => !w.includes('{'));
          const queryWords = queryLower.split(/\s+/);
          const matchedWords = templateWords.filter(w => queryWords.includes(w));

          if (matchedWords.length >= Math.min(3, templateWords.length)) {
            // Extract parameters using simple heuristics
            const intent = {};
            const paramMatch = template.match(/\{(\w+)\}/);
            if (paramMatch) {
              const paramName = paramMatch[1];
              // Extract the parameter value from query
              const words = queryLower.split(/\s+/);
              const idx = words.findIndex(w => w.includes('repo') || w.includes('space') || w.includes('page'));
              if (idx >= 0) {
                intent[paramName] = words[idx] || words[words.length - 1];
              }
            }

            if (Object.keys(intent).length > 0) {
              return {
                api,
                operationId: operation.operationId,
                operation,
                intent,
                confidence: 0.7,
              };
            }
          }
        }
      }
    }
  }

  return null;
}

/**
 * Get auth provisioning URL from spec
 */
function getProvisioningUrl(api) {
  return specs[api]?.info?.['x-postcall-provisioning-url'] || null;
}

/**
 * Execute the full PostCall flow
 */
async function executeQuery(query) {
  console.log(`\n🤖 PostCall Agent: Processing query...`);
  console.log(`   "${query}"\n`);

  // 1. Match query to operation
  const match = matchQueryToOperation(query);

  if (!match) {
    console.log('❌ Sorry, I don\'t understand that query.');
    console.log('   Try something like:');
    console.log('   - "show me issues in my test-repo"');
    console.log('   - "list spaces in Confluence"');
    return;
  }

  console.log(`✓ Matched to: ${match.api} / ${match.operationId}`);
  console.log(`  Intent:`, match.intent);

  // 2. Check for token
  const tokenData = getToken(match.api);

  if (!tokenData) {
    console.log(`\n🔐 Authentication Required for ${match.api}`);
    console.log(`────────────────────────────────────────`);

    const provisioningUrl = getProvisioningUrl(match.api);
    console.log(`\nTo use ${match.api} API, you need a token:`);
    console.log(`\n1. Visit: ${provisioningUrl}`);

    if (match.api === 'github') {
      console.log(`2. Generate a Personal Access Token`);
      console.log(`3. Come back and run: agent.storeToken('github', 'YOUR_TOKEN')`);
    } else if (match.api === 'confluence') {
      console.log(`2. Generate an API Token`);
      console.log(`3. Come back and run: agent.storeToken('confluence', {`);
      console.log(`     email: 'you@example.com',`);
      console.log(`     token: 'YOUR_TOKEN',`);
      console.log(`     domain: 'yourcompany'`);
      console.log(`   })`);
    }

    console.log(`\nThen try your query again!\n`);
    return;
  }

  console.log(`✓ Using stored ${match.api} credentials`);

  try {
    // 3. Create API client
    let client;
    if (match.api === 'github') {
      client = createGitHubClient();
    } else if (match.api === 'confluence') {
      let cloudId = tokenData.cloudId;
      if (!cloudId) {
        console.log('  Fetching Confluence Cloud ID...');
        cloudId = await fetchConfluenceCloudId();
        storeToken('confluence', { ...tokenData, cloudId });
      }
      client = createConfluenceClient(cloudId);
    }

    // 4. Execute grounding chain if needed
    let resolvedParams = {};
    const targetOp = findOperation(specs[match.api], match.operationId);

    if (targetOp.operation['x-postcall-grounding']) {
      console.log(`\n🔗 Executing grounding chain...`);
      resolvedParams = await executeGroundingChain(
        match.api,
        match.operationId,
        match.intent,
        specs[match.api],
        client
      );
    }

    // 5. Build and execute the API request
    const request = buildRequest(targetOp, match.intent, resolvedParams);
    console.log(`\n📡 Calling API: ${request.method} ${request.url}`);

    const response = await client.request(request);

    // 6. Format and display results
    console.log(`\n✅ Success!\n`);
    displayResults(match.api, match.operationId, response.data);

  } catch (error) {
    console.error(`\n❌ Error: ${error.message}`);
    if (error.code === 'auth_required_challenge') {
      console.log('\nYour token may be invalid or expired. Try getting a new one.');
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
function displayResults(api, operationId, data) {
  if (operationId === 'listIssues') {
    if (Array.isArray(data) && data.length > 0) {
      console.log(`Found ${data.length} issue(s):\n`);
      data.slice(0, 10).forEach((issue, i) => {
        console.log(`${i + 1}. #${issue.number}: ${issue.title}`);
        console.log(`   State: ${issue.state} | URL: ${issue.html_url}\n`);
      });
      if (data.length > 10) {
        console.log(`... and ${data.length - 10} more`);
      }
    } else {
      console.log('No issues found.');
    }
  } else if (operationId === 'listSpaces') {
    if (data.results && data.results.length > 0) {
      console.log(`Found ${data.results.length} space(s):\n`);
      data.results.forEach((space, i) => {
        console.log(`${i + 1}. ${space.name} (${space.key}) - ${space.type}`);
      });
    } else {
      console.log('No spaces found.');
    }
  } else if (operationId === 'searchContent') {
    if (data.results && data.results.length > 0) {
      console.log(`Found ${data.results.length} result(s):\n`);
      data.results.forEach((item, i) => {
        console.log(`${i + 1}. ${item.title} (${item.type})`);
        if (item.space) {
          console.log(`   Space: ${item.space.name}\n`);
        }
      });
    } else {
      console.log('No results found.');
    }
  } else {
    // Generic display
    console.log(JSON.stringify(data, null, 2));
  }
}

/**
 * Interactive REPL
 */
async function startREPL() {
  loadSpecs();

  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║           PostCall AI Agent - Interactive Mode             ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');
  console.log('I can help you interact with GitHub and Confluence using natural language.\n');
  console.log('Examples:');
  console.log('  • "show me issues in my test-repo"');
  console.log('  • "list issues in test-repo"');
  console.log('  • "list spaces in Confluence"');
  console.log('  • "search for Onboarding in Engineering space"\n');
  console.log('Type "exit" to quit\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

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

/**
 * Helper function to store token from REPL
 */
function storeTokenHelper(api, tokenOrData) {
  if (api === 'github') {
    storeToken('github', {
      type: 'github_pat',
      token: tokenOrData,
    });
    console.log('✓ GitHub token stored!');
  } else if (api === 'confluence') {
    storeToken('confluence', {
      type: 'confluence_api_token',
      email: tokenOrData.email,
      apiToken: tokenOrData.token,
      domain: tokenOrData.domain || null,
      cloudId: tokenOrData.cloudId || null,
    });
    console.log('✓ Confluence token stored!');
  }
}

// Export for programmatic use
module.exports = {
  executeQuery,
  storeToken: storeTokenHelper,
  matchQueryToOperation,
};

// Run REPL if executed directly
if (require.main === module) {
  startREPL();
}
