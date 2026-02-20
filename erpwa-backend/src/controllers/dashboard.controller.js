import prisma from "../prisma.js";

/**
 * Get dashboard statistics
 */
export const getDashboardStats = async (req, res) => {
    try {
        const vendorId = req.user.vendorId;
        const user = req.user;

        // Define filter for leads based on role
        const leadFilter = { vendorId };
        if (user.role === 'sales') {
            leadFilter.salesPersonName = user.name;
        }

        // Get counts in parallel
        const [
            teamCount,
            leadsCount,
            templatesCount,
            campaignsCount,
            leadsStatusCount,
        ] = await Promise.all([
            // Team members count
            prisma.user.count({
                where: { vendorId },
            }),

            // Total leads count (filtered)
            prisma.lead.count({
                where: leadFilter,
            }),

            // Templates count
            prisma.template.count({
                where: { vendorId },
            }),

            // Campaigns count
            prisma.campaign.count({
                where: {
                    vendorId,
                    ...(user.role === 'sales' ? { createdBy: user.id } : {}),
                },
            }),

            // Leads by status (filtered)
            prisma.lead.groupBy({
                by: ["status"],
                where: leadFilter,
                _count: {
                    status: true,
                },
            }),
        ]);

        // Calculate conversion rate (converted / total)
        const convertedLeads = leadsStatusCount.find((s) => s.status === "converted")?._count.status || 0;
        const conversionRate = leadsCount > 0 ? Math.round((convertedLeads / leadsCount) * 100) : 0;

        // 2. Get recent campaign activities
        const recentCampaigns = await prisma.campaign.findMany({
            where: {
                vendorId,
                ...(user.role === 'sales' ? { createdBy: user.id } : {}),
            },
            select: {
                id: true,
                name: true,
                status: true,
                type: true,
                createdAt: true,
                createdBy: true,
                totalMessages: true,
                sentMessages: true,
                failedMessages: true
            },
            orderBy: { createdAt: "desc" },
            take: 10,
        });

        const campaignUserIds = [...new Set(recentCampaigns.map(c => c.createdBy).filter(Boolean))];
        const campaignUsers = await prisma.user.findMany({
            where: { id: { in: campaignUserIds } },
            select: { id: true, name: true }
        });
        const campaignUserMap = campaignUsers.reduce((acc, u) => {
            acc[u.id] = u.name;
            return acc;
        }, {});

        // 3. Get recent messages (templates or inbound)
        const recentMessages = await prisma.message.findMany({
            where: {
                vendorId,
                OR: [
                    { direction: 'inbound' },
                    { direction: 'outbound', messageType: 'template' }
                ],
                // If sales, filter to leads they own
                ...(user.role === 'sales' ? {
                    conversation: { lead: { salesPersonName: user.name } }
                } : {}),
            },
            select: {
                id: true,
                direction: true,
                messageType: true,
                status: true,
                createdAt: true,
                sender: { select: { name: true } },
                conversation: {
                    select: {
                        lead: { select: { companyName: true, phoneNumber: true } }
                    }
                }
            },
            orderBy: { createdAt: "desc" },
            take: 15,
        });

        // 4. Get active 24h sessions
        const recentSessions = await prisma.conversation.findMany({
            where: {
                vendorId,
                sessionStartedAt: { not: null },
                sessionExpiresAt: { gt: new Date() },
                ...(user.role === 'sales' ? {
                    lead: { salesPersonName: user.name }
                } : {})
            },
            select: {
                id: true,
                sessionStartedAt: true,
                lead: { select: { companyName: true, phoneNumber: true } }
            },
            orderBy: { sessionStartedAt: "desc" },
            take: 10,
        });

        // Merge and format activities
        const events = [];

        recentCampaigns.forEach((camp) => {
            const campTypeStr = camp.type === 'TEMPLATE' ? 'Template Campaign' : 'Image Campaign';
            const memberName = campaignUserMap[camp.createdBy] || "System";
            
            let displayStatus = camp.status;
            // Infer correct status if DB still says active/processing
            if (camp.totalMessages > 0) {
                if (camp.failedMessages >= camp.totalMessages) {
                    displayStatus = 'failed';
                } else if ((camp.sentMessages + camp.failedMessages) >= camp.totalMessages) {
                    displayStatus = 'completed';
                } else if (camp.failedMessages > 0) {
                    displayStatus = 'partially failed';
                }
            }

            const actionText = `[Status: ${displayStatus}] ${campTypeStr}: ${camp.name || 'Unnamed'}`;
            events.push({ member: memberName, type: campTypeStr, action: actionText, time: camp.createdAt });
        });

        recentMessages.forEach((msg) => {
            if (msg.direction !== 'inbound') return; // Skip outbounds for this view
            const leadName = msg.conversation?.lead?.companyName || msg.conversation?.lead?.phoneNumber || "unknown user";
            let actionText = `Received an inbound message from ${leadName}`;
            const memberName = leadName; // If inbound, the member initiating is the lead
            
            events.push({ member: memberName, type: "Message", action: actionText, time: msg.createdAt });
        });

        recentSessions.forEach((session) => {
            const leadName = session.lead?.companyName || session.lead?.phoneNumber || "unknown user";
            events.push({
                member: "System",
                type: "Chat Session",
                action: `Ready for 24-hour window chat with ${leadName}`,
                time: session.sessionStartedAt,
            });
        });

        // Sort all events descending by time
        events.sort((a, b) => new Date(b.time) - new Date(a.time));

        // Format final list (top 15)
        const activities = events.slice(0, 15).map((act, index) => ({
            id: `act_${index}_${new Date(act.time).getTime()}`,
            member: act.member,
            type: act.type || "System Event",
            action: act.action,
            time: formatTimeAgo(new Date(act.time)),
        }));

        // Prepare status breakdown
        const statusBreakdown = leadsStatusCount.reduce((acc, item) => {
            acc[item.status] = item._count.status;
            return acc;
        }, {});

        res.json({
            stats: {
                teamMembers: teamCount,
                totalLeads: leadsCount,
                templates: templatesCount,
                campaigns: campaignsCount,
                conversionRate: `${conversionRate}%`,
                statusBreakdown,
            },
            recentActivities: activities,
        });
    } catch (error) {
        console.error("Dashboard stats error:", error);
        res.status(500).json({ message: "Failed to fetch dashboard statistics" });
    }
};

// Helper function to format time ago
function formatTimeAgo(date) {
    const seconds = Math.floor((new Date() - date) / 1000);

    const intervals = {
        year: 31536000,
        month: 2592000,
        week: 604800,
        day: 86400,
        hour: 3600,
        minute: 60,
    };

    for (const [unit, secondsInUnit] of Object.entries(intervals)) {
        const interval = Math.floor(seconds / secondsInUnit);
        if (interval >= 1) {
            return `${interval} ${unit}${interval > 1 ? "s" : ""} ago`;
        }
    }

    return "Just now";
}
