/**
 * Destructive UX acceptance must never run on the shared LAN service or its
 * database. Only an explicitly configured dedicated *_test DB + loopback
 * server on a non-dev port is eligible. No secrets are logged.
 */
export function validateIsolatedFixtures({base,args=[],env=process.env,explicitBase=false}){
  let target,db;
  try{
    target=new URL(base);
    db=new URL(env.DATABASE_URL||"");
  }catch{return {ok:false,reason:"invalid target/database URL"};}
  const databaseName=decodeURIComponent(db.pathname.slice(1));
  const isolatedName=env.FILESMANAGE_UX_FIXTURE_DB||"";
  if(!args.includes("--isolated-fixtures"))return {ok:false,reason:"missing --isolated-fixtures"};
  if(!explicitBase)return {ok:false,reason:"base must be provided explicitly"};
  if(!["127.0.0.1","localhost","[::1]"].includes(target.hostname))
    return {ok:false,reason:"base must be loopback"};
  if(target.protocol!=="http:"||!target.port||target.port==="18091")
    return {ok:false,reason:"base must use a distinct local test port"};
  if(!/^filesmanage_[a-z0-9_]*test$/.test(isolatedName)||isolatedName!==databaseName)
    return {ok:false,reason:"DATABASE_URL must match a dedicated *_test database"};
  return {ok:true,reason:"isolated fixture target verified"};
}
export function assertIsolatedFixtures(options){
  const result=validateIsolatedFixtures(options);
  if(!result.ok)throw Error("UX_FIXTURE_REFUSED: "+result.reason+"; refusing all destructive fixtures");
}
