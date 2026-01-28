import { MongoClient } from "mongodb";

const mongoUri =
  process.env.MONGODB_URI ?? "mongodb://localhost:27017/governance";

const sampleProjects = [
  {
    project_id: "project-atlas",
    status: "deployed",
    has_audit_log: true,
  },
  {
    project_id: "project-delta",
    status: "deployed",
    has_audit_log: false,
  },
  {
    project_id: "project-orion",
    status: "deployed",
    has_audit_log: false,
  },
];

const client = new MongoClient(mongoUri);

await client.connect();
const db = client.db();
const projects = db.collection("projects");

await projects.deleteMany({});
await projects.insertMany(sampleProjects);

console.log("Seeded projects collection with sample SDLC data.");

await client.close();
