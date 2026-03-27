import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from 'sonner';
import { Save, Eye, EyeOff, Truck, Package, Globe } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';

export default function AdminCourierSettings() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  
  // Steadfast
  const [showSteadfastApiKey, setShowSteadfastApiKey] = useState(false);
  const [showSteadfastSecretKey, setShowSteadfastSecretKey] = useState(false);
  const [steadfastApiKey, setSteadfastApiKey] = useState('');
  const [steadfastSecretKey, setSteadfastSecretKey] = useState('');
  
  // Carrybee
  const [carrybeeBaseUrl, setCarrybeeBaseUrl] = useState('https://developers.carrybee.com');
  const [carrybeeClientId, setCarrybeeClientId] = useState('');
  const [carrybeeClientSecret, setCarrybeeClientSecret] = useState('');
  const [carrybeeClientContext, setCarrybeeClientContext] = useState('');
  const [carrybeeStoreId, setCarrybeeStoreId] = useState('');
  const [showCarrybeeClientId, setShowCarrybeeClientId] = useState(false);
  const [showCarrybeeClientSecret, setShowCarrybeeClientSecret] = useState(false);
  const [showCarrybeeClientContext, setShowCarrybeeClientContext] = useState(false);

  // BD Courier
  const [showBdCourierApiKey, setShowBdCourierApiKey] = useState(false);
  const [bdCourierApiKey, setBdCourierApiKey] = useState('');

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      const { data, error } = await supabase
        .from('admin_settings')
        .select('key, value')
        .in('key', [
          'steadfast_api_key', 'steadfast_secret_key', 'bdcourier_api_key',
          'carrybee_base_url', 'carrybee_client_id', 'carrybee_client_secret',
          'carrybee_client_context', 'carrybee_store_id',
        ]);

      if (error) throw error;

      data?.forEach((setting) => {
        switch (setting.key) {
          case 'steadfast_api_key': setSteadfastApiKey(setting.value); break;
          case 'steadfast_secret_key': setSteadfastSecretKey(setting.value); break;
          case 'bdcourier_api_key': setBdCourierApiKey(setting.value); break;
          case 'carrybee_base_url': setCarrybeeBaseUrl(setting.value); break;
          case 'carrybee_client_id': setCarrybeeClientId(setting.value); break;
          case 'carrybee_client_secret': setCarrybeeClientSecret(setting.value); break;
          case 'carrybee_client_context': setCarrybeeClientContext(setting.value); break;
          case 'carrybee_store_id': setCarrybeeStoreId(setting.value); break;
        }
      });
    } catch (error) {
      console.error('Failed to load settings:', error);
      toast.error('Failed to load courier settings');
    } finally {
      setLoading(false);
    }
  };

  const saveSteadfastSettings = async () => {
    setSaving(true);
    try {
      const { error: apiError } = await supabase
        .from('admin_settings')
        .upsert(
          { key: 'steadfast_api_key', value: steadfastApiKey, updated_at: new Date().toISOString() },
          { onConflict: 'key' }
        );
      if (apiError) throw apiError;

      const { error: secretError } = await supabase
        .from('admin_settings')
        .upsert(
          { key: 'steadfast_secret_key', value: steadfastSecretKey, updated_at: new Date().toISOString() },
          { onConflict: 'key' }
        );
      if (secretError) throw secretError;

      toast.success('Steadfast credentials saved successfully');
    } catch (error) {
      console.error('Failed to save settings:', error);
      toast.error('Failed to save Steadfast settings');
    } finally {
      setSaving(false);
    }
  };

  const saveCarrybeeSettings = async () => {
    setSaving(true);
    try {
      const keys = [
        { key: 'carrybee_base_url', value: carrybeeBaseUrl },
        { key: 'carrybee_client_id', value: carrybeeClientId },
        { key: 'carrybee_client_secret', value: carrybeeClientSecret },
        { key: 'carrybee_client_context', value: carrybeeClientContext },
        { key: 'carrybee_store_id', value: carrybeeStoreId },
      ];

      for (const item of keys) {
        const { error } = await supabase
          .from('admin_settings')
          .upsert(
            { key: item.key, value: item.value, updated_at: new Date().toISOString() },
            { onConflict: 'key' }
          );
        if (error) throw error;
      }

      toast.success('Carrybee credentials saved successfully');
    } catch (error) {
      console.error('Failed to save settings:', error);
      toast.error('Failed to save Carrybee settings');
    } finally {
      setSaving(false);
    }
  };

  const saveBdCourierSettings = async () => {
    setSaving(true);
    try {
      const { error } = await supabase
        .from('admin_settings')
        .upsert(
          { key: 'bdcourier_api_key', value: bdCourierApiKey, updated_at: new Date().toISOString() },
          { onConflict: 'key' }
        );
      if (error) throw error;

      toast.success('BD Courier API key saved successfully');
    } catch (error) {
      console.error('Failed to save settings:', error);
      toast.error('Failed to save BD Courier settings');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <Card>
          <CardContent className="p-6 space-y-4">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </CardContent>
        </Card>
      </div>
    );
  }

  const PasswordField = ({
    id, label, value, onChange, show, onToggle, placeholder,
  }: {
    id: string; label: string; value: string; onChange: (v: string) => void;
    show: boolean; onToggle: () => void; placeholder: string;
  }) => (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <div className="relative">
        <Input
          id={id}
          type={show ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="pr-10"
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="absolute right-0 top-0 h-full"
          onClick={onToggle}
        >
          {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </Button>
      </div>
    </div>
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-display font-bold flex items-center gap-2">
          <Truck className="h-8 w-8" />
          Courier Settings
        </h1>
        <p className="text-muted-foreground">Manage your courier API credentials</p>
      </div>

      <Tabs defaultValue="steadfast" className="w-full">
        <TabsList className="grid w-full grid-cols-3 max-w-lg">
          <TabsTrigger value="steadfast" className="flex items-center gap-2">
            <Truck className="h-4 w-4" />
            Steadfast
          </TabsTrigger>
          <TabsTrigger value="carrybee" className="flex items-center gap-2">
            <Globe className="h-4 w-4" />
            Carrybee
          </TabsTrigger>
          <TabsTrigger value="bdcourier" className="flex items-center gap-2">
            <Package className="h-4 w-4" />
            BD Courier
          </TabsTrigger>
        </TabsList>

        {/* Steadfast Tab */}
        <TabsContent value="steadfast" className="space-y-4 mt-4">
          <Card>
            <CardHeader>
              <CardTitle>Steadfast API Credentials</CardTitle>
              <CardDescription>
                Enter your Steadfast API credentials to enable automatic courier booking.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <PasswordField
                id="steadfastApiKey" label="API Key" value={steadfastApiKey}
                onChange={setSteadfastApiKey} show={showSteadfastApiKey}
                onToggle={() => setShowSteadfastApiKey(!showSteadfastApiKey)}
                placeholder="Enter your Steadfast API Key"
              />
              <PasswordField
                id="steadfastSecretKey" label="Secret Key" value={steadfastSecretKey}
                onChange={setSteadfastSecretKey} show={showSteadfastSecretKey}
                onToggle={() => setShowSteadfastSecretKey(!showSteadfastSecretKey)}
                placeholder="Enter your Steadfast Secret Key"
              />
              <Button onClick={saveSteadfastSettings} disabled={saving} className="w-full">
                <Save className="h-4 w-4 mr-2" />
                {saving ? 'Saving...' : 'Save Steadfast Credentials'}
              </Button>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>How to Get Steadfast Credentials</CardTitle></CardHeader>
            <CardContent className="text-sm text-muted-foreground space-y-2">
              <p>1. Log in to your Steadfast merchant portal at <strong>portal.steadfast.com.bd</strong></p>
              <p>2. Navigate to Settings → API Settings</p>
              <p>3. Copy your API Key and Secret Key</p>
              <p>4. Paste them in the fields above and save</p>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Carrybee Tab */}
        <TabsContent value="carrybee" className="space-y-4 mt-4">
          <Card>
            <CardHeader>
              <CardTitle>Carrybee API Credentials</CardTitle>
              <CardDescription>
                Enter your Carrybee API credentials to enable delivery through Carrybee courier service.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="carrybeeBaseUrl">Base URL</Label>
                <Input
                  id="carrybeeBaseUrl"
                  value={carrybeeBaseUrl}
                  onChange={(e) => setCarrybeeBaseUrl(e.target.value)}
                  placeholder="https://developers.carrybee.com"
                />
              </div>
              <PasswordField
                id="carrybeeClientId" label="Client ID" value={carrybeeClientId}
                onChange={setCarrybeeClientId} show={showCarrybeeClientId}
                onToggle={() => setShowCarrybeeClientId(!showCarrybeeClientId)}
                placeholder="Enter your Client ID"
              />
              <PasswordField
                id="carrybeeClientSecret" label="Client Secret" value={carrybeeClientSecret}
                onChange={setCarrybeeClientSecret} show={showCarrybeeClientSecret}
                onToggle={() => setShowCarrybeeClientSecret(!showCarrybeeClientSecret)}
                placeholder="Enter your Client Secret"
              />
              <PasswordField
                id="carrybeeClientContext" label="Client Context" value={carrybeeClientContext}
                onChange={setCarrybeeClientContext} show={showCarrybeeClientContext}
                onToggle={() => setShowCarrybeeClientContext(!showCarrybeeClientContext)}
                placeholder="Enter your Client Context"
              />
              <div className="space-y-2">
                <Label htmlFor="carrybeeStoreId">Store ID (optional - auto-detected if empty)</Label>
                <Input
                  id="carrybeeStoreId"
                  value={carrybeeStoreId}
                  onChange={(e) => setCarrybeeStoreId(e.target.value)}
                  placeholder="Enter your Store ID"
                />
              </div>
              <Button onClick={saveCarrybeeSettings} disabled={saving} className="w-full">
                <Save className="h-4 w-4 mr-2" />
                {saving ? 'Saving...' : 'Save Carrybee Credentials'}
              </Button>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>How to Get Carrybee Credentials</CardTitle></CardHeader>
            <CardContent className="text-sm text-muted-foreground space-y-2">
              <p>1. Log in to your Carrybee merchant portal</p>
              <p>2. Navigate to API Credentials section</p>
              <p>3. Copy your Client ID, Client Secret, and Client Context</p>
              <p>4. Use <strong>https://developers.carrybee.com</strong> for production or <strong>https://stage-sandbox.carrybee.com</strong> for sandbox</p>
            </CardContent>
          </Card>
        </TabsContent>

        {/* BD Courier Tab */}
        <TabsContent value="bdcourier" className="space-y-4 mt-4">
          <Card>
            <CardHeader>
              <CardTitle>BD Courier API Credentials</CardTitle>
              <CardDescription>
                Enter your BD Courier API key to enable courier history lookup.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <PasswordField
                id="bdCourierApiKey" label="API Key" value={bdCourierApiKey}
                onChange={setBdCourierApiKey} show={showBdCourierApiKey}
                onToggle={() => setShowBdCourierApiKey(!showBdCourierApiKey)}
                placeholder="Enter your BD Courier API Key"
              />
              <Button onClick={saveBdCourierSettings} disabled={saving} className="w-full">
                <Save className="h-4 w-4 mr-2" />
                {saving ? 'Saving...' : 'Save BD Courier API Key'}
              </Button>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>How to Get BD Courier API Key</CardTitle></CardHeader>
            <CardContent className="text-sm text-muted-foreground space-y-2">
              <p>1. Visit <strong>bdcourier.com</strong> and create an account</p>
              <p>2. Navigate to your account settings or API section</p>
              <p>3. Generate or copy your API key</p>
              <p>4. Paste it in the field above and save</p>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
