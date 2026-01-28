import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { MongoClient } from "mongodb";
import { z } from "zod";

type ProjectDocument = {
  project_id: string;
  status: string;
  has_audit_log: boolean;
  status_updated_at?: Date;
};

const mongoUri = process.env.MONGODB_URI;
if (!mongoUri) {
  console.error("MONGODB_URI is required to start the governance server.");
  process.exit(1);
}

const client = new MongoClient(mongoUri);

const server = new McpServer({
  name: "cubyts-governance-engine",
  version: "0.1.0",
});

const getProjectsCollection = () =>
  client.db().collection<ProjectDocument>("projects");

server.tool(
  "detect_sdlc_drift",
  {
    description:
      "Detect projects marked as deployed without audit logs (Design-Code Drift).",
    inputSchema: z.object({}),
  },
  async () => {
    const driftedProjects = await getProjectsCollection()
      .find({ status: "deployed", has_audit_log: false })
      .toArray();

    if (driftedProjects.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: "No SDLC drift detected. All deployed projects have audit logs.",
          },
        ],
      };
    }

    const flaggedList = driftedProjects
      .map((project) => `• ${project.project_id}`)
      .join("\n");

    return {
      content: [
        {
          type: "text",
          text: `Design-Code Drift detected in the following projects:\n${flaggedList}`,
        },
      ],
    };
  }
);

server.tool(
  "reconcile_drift",
  {
    description:
      "Reconcile SDLC drift by updating documentation or reverting deployment status.",
    inputSchema: z.object({
      project_id: z.string().min(1, "project_id is required"),
      action: z.enum(["update_docs", "revert_status"]),
    }),
  },
  async ({ project_id, action }) => {
    if (action === "revert_status") {
      const result = await getProjectsCollection().updateOne(
        { project_id },
        {
          $set: {
            status: "needs_review",
            status_updated_at: new Date(),
          },
        }
      );

      if (result.matchedCount === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No project found with project_id '${project_id}'.`,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `Project '${project_id}' status reverted to needs_review and timestamp logged.`,
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: `Documentation update requested for project '${project_id}'.`,
        },
      ],
    };
  }
);

const transport = new StdioServerTransport();

await client.connect();
await server.connect(transport);

console.error("cubyts-governance-engine MCP server is running.");
