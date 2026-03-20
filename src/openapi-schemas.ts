import { phases } from "../shared/types.js";

const phaseEnum = [...phases] as [string, ...string[]];

const promptSetTypes = ["manifest", "phase_prompt", "role_prompt", "schema", "tool_prompt"] as const;

const jsonObject = {
  type: "object",
  additionalProperties: true,
  description: "Arbitrary JSON object"
} as const;

const sessionPayload = {
  type: "object",
  additionalProperties: true,
  description: "Session or session details (varies by endpoint)"
} as const;

const validationError = {
  type: "object",
  properties: {
    error: { type: "string", enum: ["validation_error"] },
    details: {
      type: "array",
      items: {
        type: "object",
        properties: {
          path: { type: "string" },
          message: { type: "string" }
        }
      }
    }
  }
} as const;

const simpleError = {
  type: "object",
  properties: {
    error: { type: "string" }
  },
  additionalProperties: true
} as const;

const notFound = {
  type: "object",
  properties: {
    error: { type: "string", enum: ["not_found"] }
  }
} as const;

export const healthGet = {
  tags: ["Health"],
  summary: "Liveness",
  description: "Returns process liveness and persistence mode.",
  response: {
    200: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["ok"] },
        persistence: { type: "string" }
      }
    },
    503: {
      type: "object",
      properties: {
        status: { type: "string" },
        persistence: { type: "string" },
        error: { type: "string" }
      }
    }
  }
};

export const readyGet = {
  tags: ["Health"],
  summary: "Readiness",
  description: "Returns readiness when persistence is initialized and healthy.",
  response: {
    200: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["ready"] },
        persistence: { type: "string" }
      }
    },
    503: {
      type: "object",
      properties: {
        status: { type: "string" },
        reason: { type: "string" }
      }
    }
  }
};

export const sessionsPost = {
  tags: ["Sessions"],
  summary: "Create session",
  body: {
    type: "object",
    required: ["problemStatement"],
    properties: {
      title: { type: "string" },
      problemStatement: { type: "string", minLength: 1 },
      roles: { type: "array", items: { type: "string" } },
      context: jsonObject
    }
  },
  response: {
    201: sessionPayload,
    400: validationError,
    500: simpleError
  }
};

export const problemStatementImprovePost = {
  tags: ["Problem statement"],
  summary: "Improve problem statement",
  body: {
    type: "object",
    required: ["problemStatement"],
    properties: {
      problemStatement: { type: "string", minLength: 1 }
    }
  },
  response: {
    200: jsonObject,
    400: simpleError,
    500: simpleError
  }
};

export const sessionsListGet = {
  tags: ["Sessions"],
  summary: "List sessions",
  response: {
    200: {
      type: "array",
      items: sessionPayload
    },
    500: simpleError
  }
};

const promptParams = {
  type: "object",
  required: ["type", "name"],
  properties: {
    type: { type: "string", enum: [...promptSetTypes] },
    name: { type: "string", minLength: 1 }
  }
};

export const adminPromptsListGet = {
  tags: ["Admin prompts"],
  summary: "List prompt sets",
  response: {
    200: jsonObject,
    500: simpleError
  }
};

export const adminPromptsDetailGet = {
  tags: ["Admin prompts"],
  summary: "Get prompt set details",
  params: promptParams,
  response: {
    200: jsonObject,
    400: validationError,
    404: simpleError,
    500: simpleError
  }
};

export const adminPromptsDraftPatch = {
  tags: ["Admin prompts"],
  summary: "Update prompt draft",
  params: promptParams,
  body: {
    type: "object",
    required: ["content"],
    properties: {
      content: { type: "string" }
    }
  },
  response: {
    200: jsonObject,
    400: validationError,
    500: simpleError
  }
};

export const adminPromptsValidatePost = {
  tags: ["Admin prompts"],
  summary: "Validate prompt set",
  params: promptParams,
  response: {
    200: jsonObject,
    400: validationError,
    500: simpleError
  }
};

export const adminPromptsPublishPost = {
  tags: ["Admin prompts"],
  summary: "Publish prompt set",
  params: promptParams,
  body: {
    type: "object",
    properties: {
      notes: { type: "string" }
    }
  },
  response: {
    200: jsonObject,
    400: simpleError,
    500: simpleError
  }
};

export const adminPromptsRestorePost = {
  tags: ["Admin prompts"],
  summary: "Restore prompt version",
  params: promptParams,
  body: {
    type: "object",
    required: ["versionId"],
    properties: {
      versionId: { type: "string", minLength: 1 }
    }
  },
  response: {
    200: jsonObject,
    400: simpleError,
    500: simpleError
  }
};

export const sessionDetailGet = {
  tags: ["Sessions"],
  summary: "Get session",
  params: {
    type: "object",
    required: ["sessionId"],
    properties: {
      sessionId: { type: "string" }
    }
  },
  response: {
    200: sessionPayload,
    400: validationError,
    404: notFound,
    500: simpleError
  }
};

export const sessionProblemFramingPatch = {
  tags: ["Sessions"],
  summary: "Update problem framing",
  description: "At least one field must be provided (enforced at runtime).",
  params: {
    type: "object",
    required: ["sessionId"],
    properties: {
      sessionId: { type: "string" }
    }
  },
  body: {
    type: "object",
    properties: {
      clarifiedProblemStatement: { type: "string", minLength: 1 },
      contextAndConstraints: { type: "string", minLength: 1 },
      successCriteria: { type: "string", minLength: 1 },
      scopeBoundaries: { type: "string", minLength: 1 },
      brainstormingLaunchQuestion: { type: "string", minLength: 1 }
    }
  },
  response: {
    200: sessionPayload,
    400: simpleError,
    500: simpleError
  }
};

export const sessionPhaseStartPost = {
  tags: ["Sessions"],
  summary: "Start phase",
  params: {
    type: "object",
    required: ["sessionId", "phase"],
    properties: {
      sessionId: { type: "string" },
      phase: { type: "string", enum: phaseEnum }
    }
  },
  response: {
    200: sessionPayload,
    400: simpleError,
    500: simpleError
  }
};

export const sessionPhaseRerunPost = {
  tags: ["Sessions"],
  summary: "Rerun phase",
  params: {
    type: "object",
    required: ["sessionId", "phase"],
    properties: {
      sessionId: { type: "string" },
      phase: { type: "string", enum: phaseEnum }
    }
  },
  response: {
    200: sessionPayload,
    400: simpleError,
    500: simpleError
  }
};

export const sessionIdeaPatch = {
  tags: ["Sessions"],
  summary: "Edit idea",
  params: {
    type: "object",
    required: ["sessionId", "ideaId"],
    properties: {
      sessionId: { type: "string" },
      ideaId: { type: "string" }
    }
  },
  body: {
    type: "object",
    required: ["text"],
    properties: {
      text: { type: "string", minLength: 1 }
    }
  },
  response: {
    200: sessionPayload,
    400: simpleError,
    500: simpleError
  }
};

export const sessionClusterPatch = {
  tags: ["Sessions"],
  summary: "Edit cluster label",
  params: {
    type: "object",
    required: ["sessionId", "clusterId"],
    properties: {
      sessionId: { type: "string" },
      clusterId: { type: "string" }
    }
  },
  body: {
    type: "object",
    required: ["label"],
    properties: {
      label: { type: "string", minLength: 1 }
    }
  },
  response: {
    200: sessionPayload,
    400: simpleError,
    500: simpleError
  }
};

export const sessionClustersMergePost = {
  tags: ["Sessions"],
  summary: "Merge clusters",
  params: {
    type: "object",
    required: ["sessionId"],
    properties: {
      sessionId: { type: "string" }
    }
  },
  body: {
    type: "object",
    required: ["clusterIds", "label"],
    properties: {
      clusterIds: { type: "array", items: { type: "string" }, minItems: 2 },
      label: { type: "string", minLength: 1 }
    }
  },
  response: {
    200: sessionPayload,
    400: simpleError,
    500: simpleError
  }
};

export const sessionClusterSplitPost = {
  tags: ["Sessions"],
  summary: "Split cluster",
  params: {
    type: "object",
    required: ["sessionId", "clusterId"],
    properties: {
      sessionId: { type: "string" },
      clusterId: { type: "string" }
    }
  },
  body: {
    type: "object",
    required: ["splits"],
    properties: {
      splits: {
        type: "array",
        minItems: 2,
        items: {
          type: "object",
          required: ["label", "ideaIds"],
          properties: {
            label: { type: "string", minLength: 1 },
            ideaIds: { type: "array", items: { type: "string" }, minItems: 1 }
          }
        }
      }
    }
  },
  response: {
    200: sessionPayload,
    400: simpleError,
    500: simpleError
  }
};

export const sessionDecisionApprovePost = {
  tags: ["Sessions"],
  summary: "Approve decision",
  params: {
    type: "object",
    required: ["sessionId"],
    properties: {
      sessionId: { type: "string" }
    }
  },
  body: {
    type: "object",
    properties: {
      recommendation: { type: "string" },
      rationale: { type: "string" },
      risks: { type: "array", items: { type: "string" } },
      nextSteps: { type: "array", items: { type: "string" } }
    }
  },
  response: {
    200: sessionPayload,
    400: simpleError,
    500: simpleError
  }
};

export const sessionDecisionSummaryPatch = {
  tags: ["Sessions"],
  summary: "Edit decision summary",
  description: "At least one field must be provided (enforced at runtime).",
  params: {
    type: "object",
    required: ["sessionId"],
    properties: {
      sessionId: { type: "string" }
    }
  },
  body: {
    type: "object",
    properties: {
      recommendation: { type: "string", minLength: 1 },
      rationale: { type: "string", minLength: 1 },
      risks: { type: "array", items: { type: "string", minLength: 1 } },
      nextSteps: { type: "array", items: { type: "string", minLength: 1 } }
    }
  },
  response: {
    200: sessionPayload,
    400: simpleError,
    500: simpleError
  }
};

export const sessionDecisionRejectPost = {
  tags: ["Sessions"],
  summary: "Reject decision",
  params: {
    type: "object",
    required: ["sessionId"],
    properties: {
      sessionId: { type: "string" }
    }
  },
  body: {
    type: "object",
    required: ["returnTarget"],
    properties: {
      returnTarget: {
        type: "string",
        enum: ["challenge_review", "cluster_review", "diverge_review"]
      }
    }
  },
  response: {
    200: sessionPayload,
    400: simpleError,
    500: simpleError
  }
};

export const sessionExportPost = {
  tags: ["Sessions"],
  summary: "Export session",
  params: {
    type: "object",
    required: ["sessionId"],
    properties: {
      sessionId: { type: "string" }
    }
  },
  body: {
    type: "object",
    properties: {
      format: { type: "string", enum: ["markdown", "pdf"], default: "markdown" }
    }
  },
  response: {
    200: jsonObject,
    400: simpleError,
    500: simpleError
  }
};
