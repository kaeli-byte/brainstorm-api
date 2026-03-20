import type { FastifyInstance } from "fastify";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";

export async function registerSwaggerPlugins(app: FastifyInstance) {
  await app.register(swagger, {
    openapi: {
      openapi: "3.0.3",
      info: {
        title: "Brainstorm Session API",
        description: "HTTP API for structured brainstorming sessions, phases, and exports.",
        version: "0.1.0"
      },
      servers: [{ url: "/", description: "This server" }],
      tags: [
        { name: "Health", description: "Liveness and readiness" },
        { name: "Sessions", description: "Session lifecycle and workflow" },
        { name: "Problem statement", description: "Pre-session helpers" },
        { name: "Admin prompts", description: "Prompt registry administration" }
      ]
    }
  });

  await app.register(swaggerUi, {
    routePrefix: "/documentation",
    uiConfig: {
      docExpansion: "list",
      deepLinking: true
    }
  });
}
