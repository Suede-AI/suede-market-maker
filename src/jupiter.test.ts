import assert from "assert";
import axios from "axios";
import { getQuote, SOL_MINT } from "./jupiter";

const originalGet = axios.get;

async function run(): Promise<void> {
  const client = axios as unknown as { get: typeof axios.get };
  client.get = async () => {
    throw {
      isAxiosError: true,
      message: "Request failed with status code 400",
      response: {
        status: 400,
        headers: {},
        data: { errorCode: "NO_ROUTES_FOUND" },
      },
    };
  };

  try {
    const quote = await getQuote("input-mint", SOL_MINT, 1);
    assert.strictEqual(quote, null, "an unroutable dust quote must be skipped");
  } finally {
    client.get = originalGet;
  }

  console.log("jupiter tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
