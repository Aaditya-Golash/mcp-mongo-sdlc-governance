// Load environment variables from .env if present. This allows local
// development without exporting MONGODB_URI, JIRA_BASE_URL, etc. See
// package.json for dependency on `dotenv`.
import 'dotenv/config';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { MongoClient } from 'mongodb';
import { z } from 'zod';

/**
 * Connection URI for MongoDB. Use the MONGODB_URI environment variable to
 * connect to your MongoDB Atlas cluster. This should include credentials
 * and the cluster address. The server will exit if the variable is missing.
 */
const mongoUri = process.env.MONGODB_URI;
if (!mongoUri) {
  console.error('MONGODB_URI is required to start the governance server.');
  process.exit(1);
}

// Create a single MongoClient instance. The driver manages connection
// pooling internally. All database and collection references are obtained
// through this client.
const client = new MongoClient(mongoUri);

// Instantiate the MCP server. The name and version are metadata only and
// can be changed to suit your environment.
const server = new McpServer({
  name: 'cubyts-governance-engine',
  version: '0.1.0',
});

/**
 * Helper function to obtain the `audit_logs` collection. Audit logs
 * record governance actions for traceability and compliance. The database
 * used here is whatever is specified as the default in MONGODB_URI; this
 * is separate from the Atlas sample datasets queried by other tools.
 */
const getAuditLogsCollection = () => client.db().collection('audit_logs');

/**
 * Tool: create_jira_ticket
 *
 * This tool allows the AI agent to open a Jira ticket to track a governance
 * remediation task. It takes a `project_id` and an `issue_description` and
 * posts a new issue to the configured Jira instance. Authentication is
 * performed using basic auth with an API token. Environment variables
 * JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN must be defined.
 */
server.registerTool(
  'create_jira_ticket',
  {
    description: 'Create a Jira ticket to track governance remediation.',
    inputSchema: {
      project_id: z.string().min(1),
      issue_description: z.string().min(1),
    },
  },
  async ({ project_id, issue_description }) => {
    const baseUrl = process.env.JIRA_BASE_URL;
    const email = process.env.JIRA_EMAIL;
    const token = process.env.JIRA_API_TOKEN;
    if (!baseUrl || !email || !token) {
      return {
        content: [
          {
            type: 'text',
            text:
              'Jira integration is not configured. Ensure JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN are set.',
          },
        ],
      };
    }
    try {
      // Build the basic auth header.
      const auth = Buffer.from(`${email}:${token}`).toString('base64');
      const summary = issue_description.split('\n')[0].substring(0, 100);
      const body = {
        fields: {
          project: { key: project_id },
          summary: summary || `Governance issue for ${project_id}`,
          description: issue_description,
          issuetype: { name: 'Task' },
        },
      };
      const response = await fetch(`${baseUrl}/rest/api/3/issue`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        let errorText = '';
        try {
          errorText = await response.text();
        } catch {
          // ignore
        }
        return {
          content: [
            {
              type: 'text',
              text: `Failed to create Jira ticket: ${response.status} ${response.statusText}. ${errorText}`,
            },
          ],
        };
      }
      const data = await response.json();
      const ticketKey = data.key ?? data.id ?? '';
      return {
        content: [
          {
            type: 'text',
            text: `Jira ticket created successfully${ticketKey ? `: ${ticketKey}` : ''}.`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text',
            text: `Error creating Jira ticket: ${err}`,
          },
        ],
      };
    }
  },
);

// -----------------------------------------------------------------------------
// Governance logic tools querying Atlas sample datasets
//
// These tools connect to specific collections in the MongoDB Atlas sample
// datasets to identify potential governance issues. Each tool returns a
// human‑readable list of identifiers that violate the check or a message
// indicating no issues were found.

// Tool: detect_pii_violations
// Scans the `sample_mflix.users` collection for documents where the `email`
// field exists. Documents with an email are returned by their `_id`.
server.registerTool(
  'detect_pii_violations',
  {
    description:
      'Detect PII violations by finding users in sample_mflix.users that have an email field.',
    inputSchema: {},
  },
  async () => {
    const usersWithEmail = await client
      .db('sample_mflix')
      .collection('users')
      .find({ email: { $exists: true } }, { projection: { _id: 1 } })
      .toArray();
    if (usersWithEmail.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: 'No PII violations detected in sample_mflix.users.',
          },
        ],
      };
    }
    const flagged = usersWithEmail.map((doc) => `• ${doc._id}`).join('\n');
    return {
      content: [
        {
          type: 'text',
          text: `Documents with PII (email field) in sample_mflix.users:\n${flagged}`,
        },
      ],
    };
  },
);

// Tool: detect_zombie_assets
// Detects 'zombie' listings in the sample_airbnb dataset. A zombie asset is
// defined here as a listing whose `last_scraped` date is older than
// January 1, 2019. This helps surface stale Airbnb listings.
server.registerTool(
  'detect_zombie_assets',
  {
    description:
      'Detect zombie Airbnb listings (last_scraped older than 2019-01-01).',
    inputSchema: {},
  },
  async () => {
    const cutoff = new Date('2019-01-01');
    const zombies = await client
      .db('sample_airbnb')
      .collection('listingsAndReviews')
      .find(
        { last_scraped: { $lt: cutoff } },
        { projection: { _id: 1, last_scraped: 1 } },
      )
      .toArray();
    if (zombies.length === 0) {
      return {
        content: [
          { type: 'text', text: 'No zombie Airbnb listings detected.' },
        ],
      };
    }
    const flagged = zombies
      .map((doc) =>
        `• ${doc._id}${
          doc.last_scraped
            ? ` (last_scraped: ${doc.last_scraped.toISOString().split('T')[0]})`
            : ''
        }`,
      )
      .join('\n');
    return {
      content: [
        {
          type: 'text',
          text: `Zombie Airbnb listings (last_scraped < 2019-01-01):\n${flagged}`,
        },
      ],
    };
  },
);

// Tool: detect_unverified_deployments
// Flags movies in the sample_mflix dataset released after 2015 that have
// zero viewer reviews in the `tomatoes.viewer.numReviews` field. This could
// indicate unverified or unpopular deployments.
server.registerTool(
  'detect_unverified_deployments',
  {
    description:
      'Detect movies from year > 2015 in sample_mflix.movies with zero viewer reviews.',
    inputSchema: {},
  },
  async () => {
    const movies = await client
      .db('sample_mflix')
      .collection('movies')
      .find(
        { year: { $gt: 2015 }, 'tomatoes.viewer.numReviews': 0 },
        { projection: { _id: 1, title: 1 } },
      )
      .toArray();
    if (movies.length === 0) {
      return {
        content: [
          { type: 'text', text: 'No unverified movie deployments detected.' },
        ],
      };
    }
    const flagged = movies
      .map((doc) => `• ${doc.title ?? doc._id}`)
      .join('\n');
    return {
      content: [
        {
          type: 'text',
          text: `Unverified deployments (movies from >2015 with zero viewer reviews):\n${flagged}`,
        },
      ],
    };
  },
);

// Tool: detect_performance_bottlenecks
// Checks the sample_weatherdata.data collection for high volume. If the total
// document count exceeds 5,000, a performance bottleneck warning is returned.
server.registerTool(
  'detect_performance_bottlenecks',
  {
    description:
      'Detect performance bottlenecks by counting documents in sample_weatherdata.data.',
    inputSchema: {},
  },
  async () => {
    const count = await client
      .db('sample_weatherdata')
      .collection('data')
      .countDocuments();
    if (count > 5000) {
      return {
        content: [
          {
            type: 'text',
            text: `Performance bottleneck detected: sample_weatherdata.data contains ${count} documents which exceeds the 5,000 document threshold.`,
          },
        ],
      };
    }
    return {
      content: [
        {
          type: 'text',
          text: `No performance bottleneck detected: sample_weatherdata.data contains ${count} documents.`,
        },
      ],
    };
  },
);

// Tool: detect_legacy_config
// Identifies legacy configuration entries in the sample_supplies.sales
// collection by finding sales where the store location is 'Denver'.
server.registerTool(
  'detect_legacy_config',
  {
    description:
      "Detect legacy configuration entries in sample_supplies.sales where storeLocation is 'Denver'.",
    inputSchema: {},
  },
  async () => {
    const legacySales = await client
      .db('sample_supplies')
      .collection('sales')
      .find({ storeLocation: 'Denver' }, { projection: { _id: 1 } })
      .toArray();
    if (legacySales.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: 'No legacy configuration entries detected in sample_supplies.sales.',
          },
        ],
      };
    }
    const flagged = legacySales.map((doc) => `• ${doc._id}`).join('\n');
    return {
      content: [
        {
          type: 'text',
          text: `Legacy configuration entries detected (storeLocation 'Denver'):\n${flagged}`,
        },
      ],
    };
  },
);

// Tool: audit_orphaned_accounts
// Finds customers in the sample_analytics dataset whose `accounts` array is
// empty. These customers are considered orphaned because they have no
// associated accounts.
server.registerTool(
  'audit_orphaned_accounts',
  {
    description:
      'Audit for orphaned customer accounts in sample_analytics.customers where the accounts array is empty.',
    inputSchema: {},
  },
  async () => {
    const orphaned = await client
      .db('sample_analytics')
      .collection('customers')
      .find({ accounts: { $size: 0 } }, { projection: { _id: 1, name: 1 } })
      .toArray();
    if (orphaned.length === 0) {
      return {
        content: [
          { type: 'text', text: 'No orphaned customer accounts detected.' },
        ],
      };
    }
    const flagged = orphaned
      .map((doc) => `• ${doc.name ?? doc._id}`)
      .join('\n');
    return {
      content: [
        {
          type: 'text',
          text: `Orphaned customer accounts detected (no associated accounts):\n${flagged}`,
        },
      ],
    };
  },
);

// -----------------------------------------------------------------------------
// Main entry point
//
// The server uses a stdio transport for communication. When running within a
// container, all logs and responses are sent via standard output and standard
// error. The MongoDB client must be connected before starting the server.
async function main() {
  try {
    await client.connect();
  } catch (err) {
    console.error('Failed to connect to MongoDB:', err);
    process.exit(1);
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('cubyts-governance-engine MCP server is running.');
}

main().catch((err) => {
  console.error('Fatal error starting server:', err);
  process.exit(1);
});