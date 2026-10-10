import fs from "node:fs";
const combinations = {
  project_members: [
    ["userId", "active"],
    ["projectId", "active"],
  ],
  tasks: [
    ["projectId", "publication", "deletedAt"],
    ["publication", "deletedAt"],
  ],
  files: [["projectId", "scope", "deletedAt"]],
  file_versions: [["taskId", "assignmentEpoch"]],
  submissions: [["projectId", "decision"]],
  notifications: [["recipientId"]],
};
const indexes = Object.entries(combinations).flatMap(([collection, lists]) =>
  lists.map((fields) => ({
    collection,
    name: fields.join("_") + "_id",
    unique: false,
    keys: [...fields, "_id"].map((field) => ({ field, direction: "asc" })),
  })),
);
fs.writeFileSync(
  "database/indexes.json",
  JSON.stringify(
    {
      note: "Create these compound indexes in console; document IDs enforce uniqueness. Queries scan equality group with _id keyset pagination.",
      indexes,
    },
    null,
    2,
  ) + "\n",
);
