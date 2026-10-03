import { buildInstagramCallbackUrl, buildMetaCallbackUrl } from "./src/config.js";
import { isInstagramLoginToken } from "./src/metaSend.js";

const igCb = buildInstagramCallbackUrl();
const fbCb = buildMetaCallbackUrl();
console.log("IG callback:", igCb);
console.log("FB callback:", fbCb);
if (igCb !== "https://example.up.railway.app/api/auth/instagram/callback") throw new Error("IG cb wrong");
if (fbCb !== "https://example.up.railway.app/api/auth/facebook/callback") throw new Error("FB cb wrong");

process.env.INSTAGRAM_REDIRECT_URI = "https://fixed.domain/api/auth/instagram/callback";
if (buildInstagramCallbackUrl() !== "https://fixed.domain/api/auth/instagram/callback") throw new Error("override wrong");

process.env.META_REDIRECT_URI = "https://meta-override.example.com/api/auth/facebook/callback";
if (buildInstagramCallbackUrl() !== "https://fixed.domain/api/auth/instagram/callback") throw new Error("IG leaked META override");
if (buildMetaCallbackUrl() !== "https://meta-override.example.com/api/auth/facebook/callback") throw new Error("FB override broken");

const scopesEnc = encodeURIComponent("instagram_business_basic,instagram_business_manage_messages");
const authUrl =
  "https://www.instagram.com/oauth/authorize?client_id=IGAPP123&redirect_uri=" +
  encodeURIComponent(buildInstagramCallbackUrl()) + "&response_type=code&scope=" + scopesEnc;
console.log("AUTH URL:", authUrl);
if (!authUrl.startsWith("https://www.instagram.com/oauth/authorize")) throw new Error("not IG authorize");
if (authUrl.includes("pages_messaging")) throw new Error("FB scopes leaked");

if (!isInstagramLoginToken("IGQVJxyz")) throw new Error("IG* not detected");
if (isInstagramLoginToken("EAAX123")) throw new Error("EAA* misdetected");

console.log("ALL CHECKS PASSED OK");
