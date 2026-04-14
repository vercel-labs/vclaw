import { checkPrereqs } from "../steps/prereqs.mjs";
import { log, success } from "../ui.mjs";

export async function doctor() {
  log("vclaw doctor — checking prerequisites\n");
  await checkPrereqs();
  success("Environment looks ready for vclaw.");
}
