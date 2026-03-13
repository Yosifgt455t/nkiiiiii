
import React, { useState, useEffect, useRef } from 'react';
import Layout from './components/Layout';
import ChatInterface from './components/ChatInterface';
import Sidebar from './components/Sidebar';
import { Auth } from './components/Auth';
import PremiumModal from './components/PremiumModal';
import { supabase, isSupabaseConfigured } from './services/supabase';
import { chatService } from './services/chatService';
import { PDFData, User, ChatHistoryEntry, ChatMessage, UserSettings } from './types';
import { jsPDF } from 'jspdf';
import html2canvas from 'html2canvas';

const App: React.FC = () => {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [isAuthLoading, setIsAuthLoading] = useState(isSupabaseConfigured);
  const [showPremiumModal, setShowPremiumModal] = useState(false);

  const checkPremiumStatus = async (email: string) => {
    if (!email || email === 'guest@nebras.local') return;
    
    console.log(`Checking premium status for ${email}...`);
    try {
      // First, check if API is even reachable
      const healthRes = await fetch('/api/health').catch(() => null);
      if (!healthRes || !healthRes.ok) {
        console.warn('API health check failed. Server might not be ready.');
        return;
      }

      const res = await fetch(`/api/user-status?email=${encodeURIComponent(email)}`);
      if (res.ok) {
        const { isPremium } = await res.json();
        console.log(`Premium status for ${email}: ${isPremium}`);
        setCurrentUser(prev => prev ? { ...prev, isPremium } : null);
      } else {
        const errorData = await res.json().catch(() => ({}));
        console.error('API returned error:', res.status, errorData);
      }
    } catch (e) {
      console.error('Error checking premium status:', e);
    }
  };
  
  // Settings management
  const [settings, setSettings] = useState<UserSettings>(() => {
    try {
      const saved = localStorage.getItem('nebras_settings');
      return saved ? JSON.parse(saved) : { theme: 'light', accentColor: 'blue' };
    } catch (e) {
      return { theme: 'light', accentColor: 'blue' };
    }
  });

  // History management
  const [allChats, setAllChats] = useState<ChatHistoryEntry[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);

  useEffect(() => {
    if (!isSupabaseConfigured) {
      // If Supabase is not configured, check if user explicitly logged out
      const isLoggedOut = localStorage.getItem('nebras_guest_logged_out');
      
      if (isLoggedOut !== 'true') {
        const savedPoints = localStorage.getItem('nebras_points_guest');
        setCurrentUser({
          username: 'ضيف',
          email: 'guest@nebras.local',
          points: savedPoints ? parseInt(savedPoints) : 100,
          joinedAt: new Date().toISOString()
        });
      }
      setIsAuthLoading(false);
    } else if (supabase) {
      // 1. Listen for Supabase Auth changes
      const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
        if (session?.user) {
          const email = session.user.email || '';
          const savedPoints = localStorage.getItem(`nebras_points_${email}`);
          const user: User = {
            username: session.user.email?.split('@')[0] || 'طالب',
            email: email,
            points: savedPoints ? parseInt(savedPoints) : 100,
            joinedAt: session.user.created_at
          };
          setCurrentUser(user);
          checkPremiumStatus(email);
        } else {
          setCurrentUser(null);
        }
        setIsAuthLoading(false);
      });

      // 2. Load initial session
      supabase.auth.getSession().then(({ data: { session } }) => {
        if (session?.user) {
          const email = session.user.email || '';
          const savedPoints = localStorage.getItem(`nebras_points_${email}`);
          const user: User = {
            username: session.user.email?.split('@')[0] || 'طالب',
            email: email,
            points: savedPoints ? parseInt(savedPoints) : 100,
            joinedAt: session.user.created_at
          };
          setCurrentUser(user);
          checkPremiumStatus(email);
        }
        setIsAuthLoading(false);
      });

      return () => {
        subscription.unsubscribe();
      };
    }
  }, []);

  // 3. Load all chats
  const [hasLoadedData, setHasLoadedData] = useState(false);
  const lastLoadedUserId = useRef<string | null>(null);

  useEffect(() => {
    const loadData = async () => {
      const currentUserId = currentUser?.email === 'guest@nebras.local' ? 'guest' : currentUser?.email;
      if (!currentUserId || (hasLoadedData && lastLoadedUserId.current === currentUserId)) return;

      console.log('Attempting to load data for:', currentUserId);

      // 1. Always try to load from LocalStorage first for immediate UI response
      const savedChats = localStorage.getItem('nebras_chat_history');
      let localChats: ChatHistoryEntry[] = [];
      if (savedChats) {
        try {
          localChats = JSON.parse(savedChats).map((chat: any) => ({
            ...chat,
            messages: (chat.messages || []).map((m: any) => ({ 
              ...m, 
              timestamp: new Date(m.timestamp) 
            }))
          }));
          console.log('Loaded from LocalStorage:', localChats.length, 'chats');
          setAllChats(localChats);
          
          const lastId = localStorage.getItem('nebras_active_chat_id');
          if (lastId && localChats.find(c => c.id === lastId)) {
            setActiveChatId(lastId);
          } else if (localChats.length > 0) {
            setActiveChatId(localChats[0].id);
          }
        } catch (e) {
          console.error('Error parsing local storage:', e);
        }
      }

      // 2. If logged in, sync with Supabase
      if (currentUser && isSupabaseConfigured && currentUser.email !== 'guest@nebras.local') {
        try {
          const { data: { session } } = await supabase!.auth.getSession();
          if (session?.user) {
            console.log('Syncing with Supabase for:', session.user.id);
            const remoteChats = await chatService.loadChats(session.user.id);
            if (remoteChats.length > 0) {
              // Merge or replace? For now, replace local with remote as remote is source of truth for logged in users
              setAllChats(remoteChats);
              const lastId = localStorage.getItem('nebras_active_chat_id');
              if (lastId && remoteChats.find(c => c.id === lastId)) {
                setActiveChatId(lastId);
              } else {
                setActiveChatId(remoteChats[0].id);
              }
            } else if (localChats.length === 0) {
              createNewChat();
            }
          }
        } catch (e) {
          console.error('Supabase sync error:', e);
        }
      } else if (localChats.length === 0) {
        createNewChat();
      }

      setHasLoadedData(true);
      lastLoadedUserId.current = currentUserId;
    };

    if (!isAuthLoading && currentUser) {
      loadData();
    }
  }, [currentUser?.email, isAuthLoading, hasLoadedData]);

  // Save history
  useEffect(() => {
    const saveData = async () => {
      if (!isAuthLoading && allChats.length >= 0) {
        // Always save to localStorage as backup
        localStorage.setItem('nebras_chat_history', JSON.stringify(allChats));

        // Save to Supabase if logged in
        if (currentUser && isSupabaseConfigured && currentUser.email !== 'guest@nebras.local') {
          const { data: { session } } = await supabase!.auth.getSession();
          if (session?.user) {
            const activeChat = allChats.find(c => c.id === activeChatId);
            if (activeChat) {
              const remoteId = await chatService.saveChat(session.user.id, activeChat);
              if (remoteId && remoteId !== activeChat.id) {
                // Update local ID to match remote UUID
                setAllChats(prev => prev.map(c => c.id === activeChat.id ? { ...c, id: remoteId } : c));
                setActiveChatId(remoteId);
              }
            }
          }
        }
      }
    };
    saveData();
  }, [allChats, isAuthLoading, activeChatId]);

  // Save settings
  useEffect(() => {
    localStorage.setItem('nebras_settings', JSON.stringify(settings));
  }, [settings]);

  // Save active chat ID
  useEffect(() => {
    if (!isAuthLoading && activeChatId) {
      localStorage.setItem('nebras_active_chat_id', activeChatId);
    }
  }, [activeChatId, isAuthLoading]);

  const createNewChat = () => {
    const newId = Date.now().toString();
    const newChat: ChatHistoryEntry = {
      id: newId,
      title: 'محادثة جديدة',
      pdf: null,
      messages: [],
      timestamp: new Date().toISOString()
    };
    setAllChats(prev => [newChat, ...prev]);
    setActiveChatId(newId);
  };

  const handleLogout = async () => {
    console.log('Logout initiated');
    try {
      if (supabase) {
        await supabase.auth.signOut();
        console.log('Supabase sign out successful');
      }
    } catch (error) {
      console.error('Logout error:', error);
    } finally {
      // Clear local state
      setCurrentUser(null);
      setActiveChatId(null);
      setAllChats([]);
      setHasLoadedData(false);
      lastLoadedUserId.current = null;

      // Clear storage
      localStorage.removeItem('nebras_active_chat_id');
      localStorage.removeItem('nebras_current_pdf');
      
      // If in guest mode, we need a flag to prevent immediate auto-login on reload
      if (!isSupabaseConfigured) {
        localStorage.setItem('nebras_guest_logged_out', 'true');
      }

      console.log('State cleared, reloading page...');
      // Use a small delay to ensure state updates are processed before reload if needed, 
      // but usually reload is enough.
      window.location.reload();
    }
  };

  const handleUpdateMessages = (chatId: string, messages: ChatMessage[]) => {
    setAllChats(prev => prev.map(chat => {
      if (chat.id === chatId) {
        let title = chat.title;
        if ((title === 'محادثة جديدة' || !title) && messages.length > 0) {
          const firstUserMsg = messages.find(m => m.role === 'user');
          if (firstUserMsg) {
            title = firstUserMsg.content.slice(0, 30) + (firstUserMsg.content.length > 30 ? '...' : '');
          }
        }
        return { ...chat, messages, title, timestamp: new Date().toISOString() };
      }
      return chat;
    }));
  };

  const handleUpdatePdf = (chatId: string, pdf: PDFData) => {
    setAllChats(prev => prev.map(chat => {
      if (chat.id === chatId) {
        return { ...chat, pdf, title: pdf.name };
      }
      return chat;
    }));
  };

  const handleClearPdf = (chatId: string) => {
    if (window.confirm('متأكد تريد تسد هذا الملف؟')) {
      setAllChats(prev => prev.map(chat => {
        if (chat.id === chatId) {
          return { ...chat, pdf: null };
        }
        return chat;
      }));
    }
  };

  const handleDeleteChat = async (chatId: string) => {
    if (window.confirm('تريد تحذف هاي المحادثة نهائياً؟')) {
      const filtered = allChats.filter(c => c.id !== chatId);
      setAllChats(filtered);
      
      if (currentUser && isSupabaseConfigured && currentUser.email !== 'guest@nebras.local') {
        await chatService.deleteChat(chatId);
      }

      if (activeChatId === chatId) {
        if (filtered.length > 0) {
          setActiveChatId(filtered[0].id);
        } else {
          createNewChat();
        }
      }
    }
  };

  const handleDownloadPDF = async () => {
    if (currentUser && !currentUser.isPremium) {
      setShowPremiumModal(true);
      return;
    }
    const activeChat = allChats.find(c => c.id === activeChatId);
    if (!activeChat || activeChat.messages.length === 0 || !currentUser) return;
    
    try {
      // Create a temporary container for PDF content
      const reportContainer = document.createElement('div');
      reportContainer.style.position = 'fixed';
      reportContainer.style.left = '-9999px';
      reportContainer.style.top = '0';
      reportContainer.style.width = '800px';
      reportContainer.style.padding = '40px';
      reportContainer.style.backgroundColor = '#ffffff';
      reportContainer.style.direction = 'rtl';
      reportContainer.style.fontFamily = 'sans-serif';
      reportContainer.className = 'pdf-report-container';

      // Header
      const header = document.createElement('div');
      header.style.textAlign = 'center';
      header.style.marginBottom = '40px';
      header.style.borderBottom = '2px solid #2563eb';
      header.style.paddingBottom = '20px';
      header.innerHTML = `
        <h1 style="color: #2563eb; margin: 0; font-size: 28px;">تقرير نبراس التعليمي</h1>
        <p style="color: #64748b; margin: 10px 0 0 0;">المدرس الخصوصي الذكي</p>
        <div style="margin-top: 20px; font-size: 14px; color: #94a3b8;">
          <span>الطالب: ${currentUser.username}</span> | 
          <span>التاريخ: ${new Date().toLocaleDateString('ar-IQ')}</span>
          ${activeChat.pdf ? `<br/><span style="margin-top: 5px; display: block;">المادة: ${activeChat.pdf.name}</span>` : ''}
        </div>
      `;
      reportContainer.appendChild(header);

      // Messages
      const messagesList = document.createElement('div');
      activeChat.messages.forEach((msg) => {
        const msgDiv = document.createElement('div');
        msgDiv.style.marginBottom = '20px';
        msgDiv.style.padding = '15px';
        msgDiv.style.borderRadius = '12px';
        msgDiv.style.backgroundColor = msg.role === 'user' ? '#f8fafc' : '#eff6ff';
        msgDiv.style.border = msg.role === 'user' ? '1px solid #e2e8f0' : '1px solid #dbeafe';
        
        const role = document.createElement('div');
        role.style.fontWeight = 'bold';
        role.style.fontSize = '12px';
        role.style.marginBottom = '8px';
        role.style.color = msg.role === 'user' ? '#475569' : '#2563eb';
        role.innerText = msg.role === 'user' ? currentUser.username : 'نبراس';
        
        const content = document.createElement('div');
        content.style.fontSize = '14px';
        content.style.lineHeight = '1.6';
        content.style.color = '#1e293b';
        content.innerText = msg.content;
        
        msgDiv.appendChild(role);
        msgDiv.appendChild(content);
        messagesList.appendChild(msgDiv);
      });
      reportContainer.appendChild(messagesList);

      // Footer
      const footer = document.createElement('div');
      footer.style.marginTop = '40px';
      footer.style.textAlign = 'center';
      footer.style.fontSize = '10px';
      footer.style.color = '#94a3b8';
      footer.innerText = 'تم توليد هذا التقرير بواسطة تطبيق نبراس الذكي';
      reportContainer.appendChild(footer);

      document.body.appendChild(reportContainer);

      const canvas = await html2canvas(reportContainer, {
        scale: 2,
        useCORS: true,
        logging: false,
        backgroundColor: '#ffffff'
      });

      const imgData = canvas.toDataURL('image/png');
      const pdf = new jsPDF('p', 'mm', 'a4');
      const imgProps = pdf.getImageProperties(imgData);
      const pdfWidth = pdf.internal.pageSize.getWidth();
      const pdfHeight = (imgProps.height * pdfWidth) / imgProps.width;
      
      pdf.addImage(imgData, 'PNG', 0, 0, pdfWidth, pdfHeight);
      pdf.save(`Nebras_Report_${Date.now()}.pdf`);

      document.body.removeChild(reportContainer);
    } catch (error) {
      console.error('PDF Generation Error:', error);
      alert('صار خطأ بتوليد التقرير، حاول مرة ثانية.');
    }
  };

  const handleUpgradeToPremium = async () => {
    if (!currentUser) return;
    try {
      console.log('Initiating checkout for:', currentUser.email);
      const apiUrl = `${window.location.origin}/api/create-checkout-session`;
      console.log('Fetching from:', apiUrl);

      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: currentUser.email }),
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        console.error('Checkout API error:', res.status, errorData);
        alert(errorData.error || `خطأ في الخادم (${res.status})`);
        return;
      }

      const { url, error } = await res.json();
      if (url) {
        console.log('Redirecting to Stripe:', url);
        window.location.href = url;
      } else {
        console.error('Checkout error from server:', error);
        alert(error || 'حدث خطأ في بدء عملية الدفع');
      }
    } catch (e: any) {
      console.error('Checkout fetch error:', e);
      alert(`حدث خطأ في الاتصال بالخادم: ${e.message || 'فشل الطلب'}`);
    }
  };

  const handleCancelSubscription = async () => {
    if (!currentUser || !currentUser.email) return;
    if (window.confirm('هل أنت متأكد من إلغاء اشتراكك البريميوم؟')) {
      try {
        const res = await fetch('/api/cancel-subscription', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: currentUser.email }),
        });
        if (res.ok) {
          alert('تم إلغاء الاشتراك بنجاح. سيتم تحديث الحالة.');
          window.location.reload();
        } else {
          const error = await res.json();
          alert(error.error || 'حدث خطأ أثناء إلغاء الاشتراك.');
        }
      } catch (e) {
        alert('حدث خطأ في الاتصال بالخادم.');
      }
    }
  };

  if (isAuthLoading) return (
    <div className="min-h-screen bg-white flex flex-col items-center justify-center font-black gap-4">
      <div className="w-16 h-16 border-4 border-blue-600 border-t-transparent rounded-full animate-spin"></div>
      <p className="text-blue-600 animate-pulse">جاري تحضير نبراس...</p>
    </div>
  );

  if (!currentUser) {
    return <Auth />;
  }

  const activeChat = allChats.find(c => c.id === activeChatId) || allChats[0];

  return (
    <Layout user={currentUser} onLogout={handleLogout} settings={settings}>
      <div className="flex w-full h-[calc(100vh-64px)] overflow-hidden">
        <Sidebar 
          currentPdf={activeChat?.pdf || null} 
          onClear={() => handleClearPdf(activeChatId!)}
          history={allChats}
          activeChatId={activeChatId}
          onSelectChat={setActiveChatId}
          onNewChat={createNewChat}
          onDeleteChat={handleDeleteChat}
          onDownloadReport={handleDownloadPDF}
          onCancelSubscription={handleCancelSubscription}
          onUpgrade={() => setShowPremiumModal(true)}
          settings={settings}
          isPremium={currentUser.isPremium}
        />
        {activeChat ? (
          <ChatInterface 
            key={activeChat.id}
            initialMessages={activeChat.messages}
            currentPdf={activeChat.pdf} 
            onPdfUpload={(pdf) => handleUpdatePdf(activeChat.id, pdf)} 
            currentUser={currentUser}
            settings={settings}
            onSettingsChange={setSettings}
            onMessagesChange={(msgs) => handleUpdateMessages(activeChat.id, msgs)}
            onDownloadReport={handleDownloadPDF}
            isPremium={currentUser.isPremium}
            onPointsUpdate={(newPoints) => {
              const updated = { ...currentUser, points: newPoints };
              setCurrentUser(updated);
              // Store points in a user-specific key if we want persistence across sessions for this user
              localStorage.setItem(`nebras_points_${currentUser.email}`, newPoints.toString());
            }}
          />
        ) : (
          <div className="flex-1 bg-slate-50 dark:bg-slate-900 flex items-center justify-center text-slate-400 font-bold">
            اختر محادثة أو ابدأ وحدة جديدة
          </div>
        )}
      </div>
      {showPremiumModal && (
        <PremiumModal 
          onClose={() => setShowPremiumModal(false)} 
          onUpgrade={handleUpgradeToPremium}
        />
      )}
    </Layout>
  );
};

export default App;
