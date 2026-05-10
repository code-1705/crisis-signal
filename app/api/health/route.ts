import { NextResponse } from "next/server";
import { loadProjectEnv } from "@/lib/env";

export const runtime = "nodejs";

export async function GET() {
  loadProjectEnv();

  return NextResponse.json({
    ok: true,
    env: {
      ANAKIN_API_KEY: Boolean(process.env.ANAKIN_API_KEY),
      AZURE_OPENAI_ENDPOINT: Boolean(process.env.AZURE_OPENAI_ENDPOINT),
      AZURE_OPENAI_API_KEY: Boolean(process.env.AZURE_OPENAI_API_KEY),
      AZURE_OPENAI_DEPLOYMENT: Boolean(process.env.AZURE_OPENAI_DEPLOYMENT)
    }
  });
}
