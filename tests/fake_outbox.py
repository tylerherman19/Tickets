"""Test-only storage adapter. PostgreSQL tests exercise real claim semantics."""
def with_outbox(db):
    claims={}
    def call(method,path,body=None,prefer=None):
        if path=='rpc/tix_runtime_health':return {}
        if path=='rpc/tix_begin_delivery':
            claims['fixture']=body
            return {'state':'sending','id':'fixture','lease':'lease','message_id':'<fixture@example.test>'}
        if path=='rpc/tix_finish_delivery':
            claim=claims[body['p_id']]
            if body['p_state']=='accepted' and claim['p_kind']=='alert':
                db('POST','tix_alerts',[{**claim['p_payload'],'watch_id':claim['p_watch_id'],'event_id':claim['p_event_id'],'channel':claim['p_channel'],'status':'sent'}])
            return None
        return db(method,path,body,prefer)
    return call
