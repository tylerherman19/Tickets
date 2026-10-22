import os,sys,unittest
from unittest.mock import patch,MagicMock
os.environ.setdefault('SUPABASE_URL','https://example.test');os.environ.setdefault('SUPABASE_SERVICE_KEY','fixture')
sys.path.insert(0,os.path.join(os.path.dirname(__file__),'..','scripts'))
import tickets_collect as c
class DeliveryTests(unittest.TestCase):
    def test_send_is_claimed_before_smtp_and_acknowledged_once(self):
        order=[]
        def db(method,path,body):
            order.append(path)
            return {'state':'sending','id':'one','lease':'lease','message_id':'<one@example.test>'} if path.endswith('begin_delivery') else None
        def send(*args,**kwargs):
            self.assertEqual(order,['rpc/tix_begin_delivery']);self.assertEqual(kwargs['message_id'],'<one@example.test>');order.append('smtp');return True
        with patch.object(c,'sb',side_effect=db),patch.object(c,'send_sms',side_effect=send):
            self.assertTrue(c.delivery_send('subject','body',watch={'id':'watch'},channel='email',kind='alert'))
        self.assertEqual(order,['rpc/tix_begin_delivery','smtp','rpc/tix_finish_delivery'])
    def test_busy_uncertain_and_previous_acceptance_never_resend(self):
        for state in ['busy','uncertain','retry_later','cancelled','already_accepted']:
            with patch.object(c,'sb',return_value={'state':state}),patch.object(c,'send_sms') as send:
                self.assertEqual(c.delivery_send('subject','body',watch={'id':'watch'},channel='email',kind='alert'),None if state in ('busy','cancelled','already_accepted') else False);send.assert_not_called()
    def test_ambiguous_smtp_failure_is_held_for_review(self):
        calls=[]
        def db(method,path,body):
            calls.append(body);return {'state':'sending','id':'one','lease':'lease','message_id':'<one@example.test>'}
        with patch.object(c,'sb',side_effect=db),patch.object(c,'send_sms',side_effect=c.DeliveryUncertain):
            self.assertFalse(c.delivery_send('subject','body',watch={'id':'watch'},channel='email',kind='alert'))
        self.assertEqual(calls[-1]['p_state'],'uncertain')
    def test_acknowledgment_failure_does_not_retry_the_mail(self):
        with patch.object(c,'sb',side_effect=[{'state':'sending','id':'one','lease':'lease','message_id':'<one@example.test>'},OSError('database')]),patch.object(c,'send_sms',return_value=True) as send:
            with self.assertRaises(OSError):c.delivery_send('subject','body',watch={'id':'watch'},channel='email',kind='alert')
            send.assert_called_once()
    def test_transport_disconnect_after_data_is_uncertain(self):
        smtp=MagicMock();smtp.__enter__.return_value.send_message.side_effect=OSError('disconnected')
        with patch.object(c,'GMAIL_ADDRESS','sender@example.test'),patch.object(c,'GMAIL_APP_PASSWORD','fixture'),patch('smtplib.SMTP_SSL',return_value=smtp):
            with self.assertRaises(c.DeliveryUncertain):c.send_sms('subject','body',recipient='to@example.test',message_id='<stable@example.test>')

